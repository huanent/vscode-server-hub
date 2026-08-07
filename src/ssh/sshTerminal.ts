import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Duplex } from 'stream';
import { Client, ClientChannel, FileEntryWithStats, SFTPWrapper } from 'ssh2';
import { formatByteRate, RemoteMetricsFormatter, RemoteMetricsReader } from './remoteMetrics';
import { SshServer } from '../servers/server';
import { ServerCredentials } from '../servers/serverStore';
import { getWebviewHtml } from '../webview';

interface SshWebviewMessage {
	type: 'input' | 'resize' | 'ready' | 'sftpList' | 'sftpDelete' | 'sftpDownload' | 'sftpUpload' | 'sftpCopyPath' | 'sftpCreateDirectory' | 'sftpProperties' | 'sftpEdit' | 'sftpToggleFavorite';
	data?: unknown;
	rows?: unknown;
	columns?: unknown;
	path?: unknown;
	isDirectory?: unknown;
}

const metricsRefreshIntervalMs = 5000;
const sftpFavoritesStateKey = 'server-hub.sftpFavorites';
const sftpEditTempRoot = path.join(os.tmpdir(), 'server-hub-sftp-edit');
const sftpEditFiles = new Map<string, {
	remotePath: string;
	upload: (localPath: string, remotePath: string) => Promise<void>;
	pendingSave: Promise<void>;
}>();
let activeSshSession: SshWebviewSession | undefined;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function initializeSftpFileEditing(context: vscode.ExtensionContext): Promise<void> {
	await fs.rm(sftpEditTempRoot, { recursive: true, force: true });
	await fs.mkdir(sftpEditTempRoot, { recursive: true });
	sftpEditFiles.clear();
	context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
		const editFile = sftpEditFiles.get(document.uri.fsPath);
		if (!editFile) {
			return;
		}
		editFile.pendingSave = editFile.pendingSave
			.catch(() => undefined)
			.then(() => editFile.upload(document.uri.fsPath, editFile.remotePath))
			.catch(error => {
				void vscode.window.showErrorMessage(`Could not save remote file: ${errorMessage(error)}`);
			});
	}));
}

export function toggleSftpForActiveTerminal(): void {
	activeSshSession?.toggleSftp();
}

export function configureSshTerminal(
	context: vscode.ExtensionContext,
	panel: vscode.WebviewPanel,
	server: SshServer,
	credentials: ServerCredentials,
): void {
	const extensionUri = context.extensionUri;
	panel.title = server.name;
	panel.webview.options = {
		enableScripts: true,
		localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
	};
	panel.iconPath = new vscode.ThemeIcon('terminal');
	panel.webview.html = getWebviewHtml(panel.webview, extensionUri, 'sshTerminal', server.name);

	const session = new SshWebviewSession(context.globalState, panel, server, credentials);
	activeSshSession = session;
	panel.onDidChangeViewState(event => {
		if (event.webviewPanel.active) {
			activeSshSession = session;
		}
	});
	panel.onDidDispose(() => {
		if (activeSshSession === session) {
			activeSshSession = undefined;
		}
		session.dispose();
	});
	panel.webview.onDidReceiveMessage((message: SshWebviewMessage) => session.handleMessage(message));
}

class SshWebviewSession {
	private readonly client = new Client();
	private readonly metricsReader = new RemoteMetricsReader();
	private readonly metricsFormatter = new RemoteMetricsFormatter();
	private shellStream: ClientChannel | undefined;
	private sftp: SFTPWrapper | undefined;
	private proxyProcess: ChildProcessWithoutNullStreams | undefined;
	private dimensions: { rows: number; columns: number } | undefined;
	private metricsTimer: NodeJS.Timeout | undefined;
	private metricsRequestPending = false;
	private webviewReady = false;
	private connected = false;
	private disposed = false;
	private failed = false;
	private sftpVisible = false;
	private sftpPath = '.';

	constructor(
		private readonly globalState: vscode.Memento,
		private readonly panel: vscode.WebviewPanel,
		private readonly server: SshServer,
		private readonly credentials: ServerCredentials,
	) {}

	handleMessage(message: SshWebviewMessage): void {
		if (message.type === 'ready' && !this.webviewReady) {
			this.webviewReady = true;
			this.postMessage({ type: 'initialize', server: { name: this.server.name, address: `${this.server.username}@${this.server.host}:${this.server.port}` } });
			this.postSftpFavorites();
			if (this.sftpVisible) {
				this.postMessage({ type: 'showSftp' });
			}
			this.connect();
			return;
		}
		if (message.type === 'input' && typeof message.data === 'string') {
			this.shellStream?.write(message.data);
			return;
		}
		if (message.type === 'sftpList' && typeof message.path === 'string') {
			void this.loadSftpDirectory(message.path);
			return;
		}
		if (
			message.type === 'sftpDownload'
			&& typeof message.path === 'string'
			&& typeof message.isDirectory === 'boolean'
		) {
			void this.downloadSftpEntry(message.path, message.isDirectory);
			return;
		}
		if (message.type === 'sftpUpload' && typeof message.path === 'string') {
			void this.uploadSftpFiles(message.path);
			return;
		}
		if (message.type === 'sftpCreateDirectory' && typeof message.path === 'string') {
			void this.createSftpDirectory(message.path);
			return;
		}
		if (
			message.type === 'sftpDelete'
			&& typeof message.path === 'string'
			&& typeof message.isDirectory === 'boolean'
		) {
			void this.deleteSftpEntry(message.path, message.isDirectory);
			return;
		}
		if (message.type === 'sftpCopyPath' && typeof message.path === 'string') {
			void vscode.env.clipboard.writeText(message.path);
			return;
		}
		if (message.type === 'sftpProperties' && typeof message.path === 'string') {
			void this.showSftpProperties(message.path);
			return;
		}
		if (message.type === 'sftpEdit' && typeof message.path === 'string') {
			void this.editSftpFile(message.path);
			return;
		}
		if (message.type === 'sftpToggleFavorite' && typeof message.path === 'string') {
			void this.toggleSftpFavorite(message.path);
			return;
		}
		if (
			message.type === 'resize'
			&& typeof message.rows === 'number'
			&& Number.isInteger(message.rows)
			&& message.rows > 0
			&& typeof message.columns === 'number'
			&& Number.isInteger(message.columns)
			&& message.columns > 0
		) {
			this.dimensions = { rows: message.rows, columns: message.columns };
			this.shellStream?.setWindow(message.rows, message.columns, 0, 0);
		}
	}

	toggleSftp(): void {
		this.sftpVisible = !this.sftpVisible;
		this.postMessage({ type: this.sftpVisible ? 'showSftp' : 'hideSftp' });
		if (this.sftpVisible && this.connected) {
			void this.loadSftpDirectory(this.sftpPath);
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.stopMetricsPolling();
		this.shellStream?.close();
		this.sftp?.end();
		this.client.end();
		this.stopProxyProcess();
	}

	private connect(): void {
		this.postMessage({ type: 'status', status: 'connecting', message: `${this.server.username}@${this.server.host}:${this.server.port}...` });
		const proxySocket = this.server.proxyCommand ? this.startProxyCommand(this.server.proxyCommand) : undefined;
		this.client
			.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
				finish(prompts.map(() => this.credentials.password ?? ''));
			})
			.on('ready', () => this.openRemoteShell())
			.on('error', error => this.handleConnectionFailure(error))
			.connect({
				host: this.server.host,
				port: this.server.port,
				username: this.server.username,
				...(proxySocket ? { sock: proxySocket } : {}),
				...(this.server.authType === 'privateKey'
					? { privateKey: this.credentials.privateKey, passphrase: this.credentials.passphrase }
					: { password: this.credentials.password, tryKeyboard: true }),
				readyTimeout: 15_000,
			});
	}

	private startProxyCommand(command: string): Duplex {
		const proxyProcess = spawn(command, {
			shell: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.proxyProcess = proxyProcess;
		let stderr = '';
		proxyProcess.stderr.setEncoding('utf8');
		proxyProcess.stderr.on('data', data => {
			stderr = (stderr + data).slice(-4000);
		});
		proxyProcess.on('error', error => this.handleConnectionFailure(error));
		proxyProcess.on('exit', (code, signal) => {
			if (this.disposed || this.failed || this.connected) {
				return;
			}
			const detail = stderr.trim();
			const reason = detail || `Proxy command exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`;
			this.handleConnectionFailure(new Error(reason));
		});
		return Duplex.from({ readable: proxyProcess.stdout, writable: proxyProcess.stdin });
	}

	private stopProxyProcess(): void {
		if (this.proxyProcess && this.proxyProcess.exitCode === null && this.proxyProcess.signalCode === null) {
			this.proxyProcess.kill();
		}
		this.proxyProcess = undefined;
	}

	private openRemoteShell(): void {
		const rows = this.dimensions?.rows ?? 24;
		const columns = this.dimensions?.columns ?? 80;
		this.client.shell({ term: 'xterm-256color', rows, cols: columns }, (error, stream) => {
			if (error) {
				this.handleConnectionFailure(error);
				return;
			}

			this.connected = true;
			this.shellStream = stream;
			this.postMessage({ type: 'status', status: 'connected', message: 'Connected' });
			stream.on('data', (data: Buffer) => this.postMessage({ type: 'output', data: data.toString('base64') }));
			stream.stderr.on('data', (data: Buffer) => this.postMessage({ type: 'output', data: data.toString('base64') }));
			stream.on('close', () => this.handleShellClosed());
			this.startMetricsPolling();
			if (this.sftpVisible) {
				void this.loadSftpDirectory(this.sftpPath);
			}
		});
	}

	private async loadSftpDirectory(requestedPath: string): Promise<void> {
		this.postMessage({ type: 'sftpLoading', path: requestedPath });
		try {
			const sftp = await this.getSftp();
			const resolvedPath = await new Promise<string>((resolve, reject) => {
				sftp.realpath(requestedPath, (error, absolutePath) => error ? reject(error) : resolve(absolutePath));
			});
			const entries = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
				sftp.readdir(resolvedPath, (error, list) => error ? reject(error) : resolve(list));
			});
			this.sftpPath = resolvedPath;
			this.postMessage({
				type: 'sftpEntries',
				path: resolvedPath,
				parentPath: resolvedPath === '/' ? null : path.posix.dirname(resolvedPath),
				entries: entries
					.filter(entry => entry.filename !== '.' && entry.filename !== '..')
					.sort((left, right) => Number(right.attrs.isDirectory()) - Number(left.attrs.isDirectory()) || left.filename.localeCompare(right.filename))
					.map(entry => ({
						name: entry.filename,
						path: path.posix.join(resolvedPath, entry.filename),
						isDirectory: entry.attrs.isDirectory(),
						size: entry.attrs.size,
						modifiedAt: entry.attrs.mtime * 1000,
					})),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.postMessage({ type: 'sftpError' });
			void vscode.window.showErrorMessage(`Could not load SFTP directory: ${message}`);
		}
	}

	private async downloadSftpEntry(remotePath: string, isDirectory: boolean): Promise<void> {
		try {
			const sftp = await this.getSftp();
			if (isDirectory) {
				const destinations = await vscode.window.showOpenDialog({
					title: `Download ${path.posix.basename(remotePath)} To`,
					defaultUri: vscode.Uri.file(os.homedir()),
					canSelectFiles: false,
					canSelectFolders: true,
					canSelectMany: false,
				});
				if (!destinations?.length) {
					return;
				}
				await this.downloadSftpDirectory(sftp, remotePath, destinations[0].fsPath);
			} else {
				const destination = await vscode.window.showSaveDialog({
					title: 'Download SFTP File',
					defaultUri: vscode.Uri.file(path.join(os.homedir(), path.posix.basename(remotePath))),
				});
				if (!destination) {
					return;
				}
				await vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: `Downloading ${path.posix.basename(remotePath)}`,
					cancellable: true,
				}, (progress, token) => this.downloadSftpFile(
					sftp,
					remotePath,
					destination.fsPath,
					progress,
					token,
				));
			}
			void vscode.window.showInformationMessage(`Downloaded ${path.posix.basename(remotePath)}.`);
		} catch (error) {
			if (error instanceof vscode.CancellationError) {
				return;
			}
			void vscode.window.showErrorMessage(`Could not download item: ${this.errorMessage(error)}`);
		}
	}

	private async editSftpFile(remotePath: string): Promise<void> {
		try {
			const sftp = await this.getSftp();
			const editDirectory = path.join(sftpEditTempRoot, randomUUID());
			const localPath = path.join(editDirectory, path.posix.basename(remotePath));
			await fs.mkdir(editDirectory, { recursive: true });
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: `Opening ${path.posix.basename(remotePath)}`,
			}, progress => this.transferFile(
				(progressStep, done) => sftp.fastGet(remotePath, localPath, { step: progressStep }, done),
				progress,
			));
			sftpEditFiles.set(localPath, {
				remotePath,
				upload: (source, destination) => this.uploadEditedSftpFile(source, destination),
				pendingSave: Promise.resolve(),
			});
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(localPath));
			await vscode.window.showTextDocument(document, { preview: false });
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not edit remote file: ${this.errorMessage(error)}`);
		}
	}

	private async uploadEditedSftpFile(localPath: string, remotePath: string): Promise<void> {
		if (this.disposed || !this.connected) {
			throw new Error('The SSH connection is no longer available.');
		}
		const sftp = await this.getSftp();
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: `Saving ${path.posix.basename(remotePath)}`,
		}, progress => this.transferFile(
			(progressStep, done) => sftp.fastPut(localPath, remotePath, { step: progressStep }, done),
			progress,
		));
		if (path.posix.dirname(remotePath) === this.sftpPath) {
			await this.loadSftpDirectory(this.sftpPath);
		}
	}

	private async downloadSftpDirectory(sftp: SFTPWrapper, remotePath: string, destinationRoot: string): Promise<void> {
		const files = await this.collectSftpFiles(sftp, remotePath);
		const localRoot = path.join(destinationRoot, path.posix.basename(remotePath));
		const totalSize = files.reduce((total, file) => total + file.size, 0);
		await fs.mkdir(localRoot, { recursive: true });
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: `Downloading ${path.posix.basename(remotePath)}`,
			cancellable: true,
		}, async (progress, token) => {
			let completedSize = 0;
			for (const file of files) {
				if (token.isCancellationRequested) {
					throw new vscode.CancellationError();
				}
				const relativePath = path.posix.relative(remotePath, file.remotePath);
				const localPath = path.join(localRoot, ...relativePath.split('/'));
				await fs.mkdir(path.dirname(localPath), { recursive: true });
				await this.downloadSftpFile(
					sftp,
					file.remotePath,
					localPath,
					progress,
					token,
					totalSize,
					completedSize,
				);
				completedSize += file.size;
			}
		});
	}

	private async downloadSftpFile(
		sftp: SFTPWrapper,
		remotePath: string,
		localPath: string,
		progress: vscode.Progress<{ increment?: number; message?: string }>,
		cancellationToken: vscode.CancellationToken,
		totalSize?: number,
		completedSize = 0,
	): Promise<void> {
		const temporaryPath = path.join(
			path.dirname(localPath),
			`.${path.basename(localPath)}.server-hub-download-${randomUUID()}.tmp`,
		);
		try {
			await this.transferFile(
				(progressStep, done) => sftp.fastGet(remotePath, temporaryPath, { step: progressStep }, done),
				progress,
				totalSize,
				completedSize,
				cancellationToken,
			);
			await this.replaceDownloadedFile(temporaryPath, localPath);
		} finally {
			await fs.rm(temporaryPath, { force: true });
		}
	}

	private async replaceDownloadedFile(temporaryPath: string, localPath: string): Promise<void> {
		try {
			await fs.rename(temporaryPath, localPath);
		} catch (error) {
			if (!(error instanceof Error) || !('code' in error) || (error.code !== 'EEXIST' && error.code !== 'EPERM')) {
				throw error;
			}
			await fs.rm(localPath, { force: true });
			await fs.rename(temporaryPath, localPath);
		}
	}

	private async collectSftpFiles(sftp: SFTPWrapper, remoteDirectory: string): Promise<Array<{ remotePath: string; size: number }>> {
		const entries = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
			sftp.readdir(remoteDirectory, (error, list) => error ? reject(error) : resolve(list));
		});
		const files: Array<{ remotePath: string; size: number }> = [];
		for (const entry of entries) {
			if (entry.filename === '.' || entry.filename === '..') {
				continue;
			}
			const remotePath = path.posix.join(remoteDirectory, entry.filename);
			if (entry.attrs.isDirectory()) {
				files.push(...await this.collectSftpFiles(sftp, remotePath));
			} else {
				files.push({ remotePath, size: entry.attrs.size });
			}
		}
		return files;
	}

	private async uploadSftpFiles(remoteDirectory: string): Promise<void> {
		const sources = await vscode.window.showOpenDialog({
			title: `Upload Files to ${remoteDirectory}`,
			defaultUri: vscode.Uri.file(os.homedir()),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: true,
		});
		if (!sources?.length) {
			return;
		}

		try {
			const sftp = await this.getSftp();
			const sizes = await Promise.all(sources.map(async source => (await fs.stat(source.fsPath)).size));
			const totalSize = sizes.reduce((total, size) => total + size, 0);
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: sources.length === 1 ? `Uploading ${path.basename(sources[0].fsPath)}` : `Uploading ${sources.length} files`,
			}, async progress => {
				let completedSize = 0;
				for (let index = 0; index < sources.length; index++) {
					const source = sources[index];
					const remotePath = path.posix.join(remoteDirectory, path.basename(source.fsPath));
					await this.transferFile(
						(progressStep, done) => sftp.fastPut(source.fsPath, remotePath, { step: progressStep }, done),
						progress,
						totalSize,
						completedSize,
					);
					completedSize += sizes[index];
				}
			});
			void vscode.window.showInformationMessage(`Uploaded ${sources.length} file${sources.length === 1 ? '' : 's'}.`);
			await this.loadSftpDirectory(remoteDirectory);
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not upload file: ${this.errorMessage(error)}`);
		}
	}

	private async createSftpDirectory(remoteDirectory: string): Promise<void> {
		const name = await vscode.window.showInputBox({
			title: `New Folder in ${remoteDirectory}`,
			prompt: 'Enter a folder name',
			validateInput: value => {
				const folderName = value.trim();
				if (!folderName) {
					return 'Folder name is required';
				}
				if (folderName === '.' || folderName === '..' || folderName.includes('/') || folderName.includes('\\')) {
					return 'Folder name cannot contain path separators';
				}
				return undefined;
			},
		});
		const folderName = name?.trim();
		if (!folderName) {
			return;
		}

		try {
			const sftp = await this.getSftp();
			const remotePath = path.posix.join(remoteDirectory, folderName);
			await new Promise<void>((resolve, reject) => sftp.mkdir(remotePath, error => error ? reject(error) : resolve()));
			await this.loadSftpDirectory(remoteDirectory);
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not create folder: ${this.errorMessage(error)}`);
		}
	}

	private async showSftpProperties(remotePath: string): Promise<void> {
		try {
			const sftp = await this.getSftp();
			const stats = await new Promise<import('ssh2').Stats>((resolve, reject) => {
				sftp.stat(remotePath, (error, result) => error ? reject(error) : resolve(result));
			});
			const type = stats.isDirectory()
				? 'Folder'
				: stats.isFile()
					? 'File'
					: stats.isSymbolicLink()
						? 'Symbolic Link'
						: 'Other';
			const permissions = (stats.mode & 0o7777).toString(8).padStart(4, '0');
			const detail = [
				`Path: ${remotePath}`,
				`Type: ${type}`,
				`Size: ${stats.size} bytes`,
				`Permissions: ${permissions}`,
				`UID: ${stats.uid}`,
				`GID: ${stats.gid}`,
				`Accessed: ${new Date(stats.atime * 1000).toLocaleString()}`,
				`Modified: ${new Date(stats.mtime * 1000).toLocaleString()}`,
			].join('\n');
			await vscode.window.showInformationMessage(
				`Properties: ${path.posix.basename(remotePath) || remotePath}`,
				{ modal: true, detail },
			);
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not load properties: ${this.errorMessage(error)}`);
		}
	}

	private async deleteSftpEntry(remotePath: string, isDirectory: boolean): Promise<void> {
		const name = path.posix.basename(remotePath);
		const confirmation = await vscode.window.showWarningMessage(
			`Delete ${isDirectory ? 'folder' : 'file'} “${name}”?`,
			{ modal: true },
			'Delete',
		);
		if (confirmation !== 'Delete') {
			return;
		}

		try {
			const sftp = await this.getSftp();
			await this.removeSftpEntry(sftp, remotePath, isDirectory);
			await this.loadSftpDirectory(path.posix.dirname(remotePath));
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not delete ${name}: ${this.errorMessage(error)}`);
		}
	}

	private async removeSftpEntry(sftp: SFTPWrapper, remotePath: string, isDirectory: boolean): Promise<void> {
		if (!isDirectory) {
			await new Promise<void>((resolve, reject) => sftp.unlink(remotePath, error => error ? reject(error) : resolve()));
			return;
		}

		const entries = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
			sftp.readdir(remotePath, (error, list) => error ? reject(error) : resolve(list));
		});
		for (const entry of entries) {
			if (entry.filename === '.' || entry.filename === '..') {
				continue;
			}
			await this.removeSftpEntry(sftp, path.posix.join(remotePath, entry.filename), entry.attrs.isDirectory());
		}
		await new Promise<void>((resolve, reject) => sftp.rmdir(remotePath, error => error ? reject(error) : resolve()));
	}

	private transferFile(
		start: (step: (total: number, chunkSize: number, fileSize: number) => void, done: (error?: Error | null) => void) => void,
		progress: vscode.Progress<{ increment?: number; message?: string }>,
		totalSize?: number,
		completedSize = 0,
		cancellationToken?: vscode.CancellationToken,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			let lastReported = completedSize;
			let speedSampleStartedAt = Date.now();
			let speedSampleBytes = 0;
			let speedMessage: string | undefined;
			let cancelled = cancellationToken?.isCancellationRequested ?? false;
			const cancellationSubscription = cancellationToken?.onCancellationRequested(() => {
				cancelled = true;
				const activeSftp = this.sftp;
				this.sftp = undefined;
				activeSftp?.end();
			});
			if (cancelled) {
				cancellationSubscription?.dispose();
				reject(new vscode.CancellationError());
				return;
			}
			start((transferred, chunkSize, fileSize) => {
				const overallSize = totalSize ?? fileSize;
				const current = completedSize + transferred;
				const increment = overallSize > 0 ? ((current - lastReported) / overallSize) * 100 : 0;
				const now = Date.now();
				const elapsedMilliseconds = now - speedSampleStartedAt;
				speedSampleBytes += chunkSize;
				if (elapsedMilliseconds >= 500 || transferred >= fileSize) {
					if (elapsedMilliseconds > 0) {
						speedMessage = formatByteRate(speedSampleBytes * 1000 / elapsedMilliseconds);
					}
					speedSampleStartedAt = now;
					speedSampleBytes = 0;
				}
				lastReported = current;
				progress.report({ increment, message: speedMessage });
			}, error => {
				cancellationSubscription?.dispose();
				if (cancelled) {
					reject(new vscode.CancellationError());
				} else if (error) {
					reject(error);
				} else {
					resolve();
				}
			});
		});
	}

	private async toggleSftpFavorite(remotePath: string): Promise<void> {
		const favoritesByServer = this.globalState.get<Record<string, string[]>>(sftpFavoritesStateKey, {});
		const favorites = favoritesByServer[this.server.id] ?? [];
		const updatedFavorites = favorites.includes(remotePath)
			? favorites.filter(favorite => favorite !== remotePath)
			: [...favorites, remotePath].sort((left, right) => left.localeCompare(right));
		await this.globalState.update(sftpFavoritesStateKey, {
			...favoritesByServer,
			[this.server.id]: updatedFavorites,
		});
		this.postSftpFavorites(updatedFavorites);
	}

	private postSftpFavorites(favorites?: string[]): void {
		this.postMessage({
			type: 'sftpFavorites',
			favorites: favorites ?? this.globalState.get<Record<string, string[]>>(sftpFavoritesStateKey, {})[this.server.id] ?? [],
		});
	}

	private errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	private getSftp(): Promise<SFTPWrapper> {
		if (this.sftp) {
			return Promise.resolve(this.sftp);
		}
		if (!this.connected) {
			return Promise.reject(new Error('SSH connection is not ready.'));
		}
		return new Promise((resolve, reject) => {
			this.client.sftp((error, sftp) => {
				if (error) {
					reject(error);
					return;
				}
				this.sftp = sftp;
				resolve(sftp);
			});
		});
	}

	private startMetricsPolling(): void {
		this.stopMetricsPolling();
		this.metricsFormatter.reset();
		void this.refreshMetrics();
		this.metricsTimer = setInterval(() => void this.refreshMetrics(), metricsRefreshIntervalMs);
	}

	private stopMetricsPolling(): void {
		if (this.metricsTimer) {
			clearInterval(this.metricsTimer);
			this.metricsTimer = undefined;
		}
		this.metricsFormatter.reset();
	}

	private async refreshMetrics(): Promise<void> {
		if (this.disposed || this.failed || !this.connected || this.metricsRequestPending) {
			return;
		}

		this.metricsRequestPending = true;
		try {
			const metrics = await this.metricsReader.read(this.client);
			if (!this.disposed && !this.failed) {
				this.postMessage({ type: 'metrics', metrics: this.metricsFormatter.format(metrics) });
			}
		} catch {
			if (!this.disposed && !this.failed) {
				this.postMessage({ type: 'metricsUnavailable' });
			}
		} finally {
			this.metricsRequestPending = false;
		}
	}

	private handleShellClosed(): void {
		if (this.disposed) {
			return;
		}
		this.connected = false;
		this.stopMetricsPolling();
		this.client.end();
		this.stopProxyProcess();
		this.postMessage({ type: 'status', status: 'closed', message: 'Connection closed' });
	}

	private handleConnectionFailure(error: Error): void {
		if (this.failed || this.disposed) {
			return;
		}

		this.failed = true;
		this.connected = false;
		this.stopMetricsPolling();
		const reason = error.message === 'All configured authentication methods failed'
			? `Authentication failed. Check the username and ${this.server.authType === 'privateKey' ? 'private key certificate' : 'password'}, and confirm that the server allows this authentication method.`
			: error.message;
		this.postMessage({ type: 'status', status: 'error', message: reason });
		this.client.end();
		this.stopProxyProcess();
	}

	private postMessage(message: unknown): void {
		if (!this.disposed) {
			void this.panel.webview.postMessage(message);
		}
	}
}

