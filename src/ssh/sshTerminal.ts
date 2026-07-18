import * as vscode from 'vscode';
import * as path from 'path';
import { Client, ClientChannel, FileEntryWithStats, SFTPWrapper } from 'ssh2';
import { RemoteMetricsFormatter, RemoteMetricsReader } from './remoteMetrics';
import { SshServer } from '../servers/server';
import { codiconsDistUri, createNonce, escapeHtml } from '../webview/webviewUtils';

interface SshWebviewMessage {
	type: 'input' | 'resize' | 'ready' | 'sftpList';
	data?: unknown;
	rows?: unknown;
	columns?: unknown;
	path?: unknown;
}

const metricsRefreshIntervalMs = 5000;
let activeSshSession: SshWebviewSession | undefined;

export function toggleSftpForActiveTerminal(): void {
	activeSshSession?.toggleSftp();
}

export function configureSshTerminal(
	extensionUri: vscode.Uri,
	panel: vscode.WebviewPanel,
	server: SshServer,
	password: string,
): void {
	const resourcesRoot = vscode.Uri.joinPath(extensionUri, 'resources');
	const xtermRoot = vscode.Uri.joinPath(resourcesRoot, 'xterm');
	panel.title = server.name;
	panel.webview.options = {
		enableScripts: true,
		localResourceRoots: [resourcesRoot, codiconsDistUri(extensionUri)],
	};
	panel.iconPath = new vscode.ThemeIcon('terminal-linux');
	panel.webview.html = renderSshTerminal(panel.webview, extensionUri, xtermRoot, server);

	const session = new SshWebviewSession(panel, server, password);
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
		private readonly panel: vscode.WebviewPanel,
		private readonly server: SshServer,
		private readonly password: string,
	) {}

	handleMessage(message: SshWebviewMessage): void {
		if (message.type === 'ready' && !this.webviewReady) {
			this.webviewReady = true;
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
	}

	private connect(): void {
		this.postMessage({ type: 'status', status: 'connecting', message: `${this.server.username}@${this.server.host}:${this.server.port}...` });
		this.client
			.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
				finish(prompts.map(() => this.password));
			})
			.on('ready', () => this.openRemoteShell())
			.on('error', error => this.handleConnectionFailure(error))
			.connect({
				host: this.server.host,
				port: this.server.port,
				username: this.server.username,
				password: this.password,
				tryKeyboard: true,
				readyTimeout: 15_000,
			});
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
			? 'Authentication failed. Check the username and password, and confirm that the server allows password authentication.'
			: error.message;
		this.postMessage({ type: 'status', status: 'error', message: reason });
		this.client.end();
	}

	private postMessage(message: unknown): void {
		if (!this.disposed) {
			void this.panel.webview.postMessage(message);
		}
	}
}

function renderSshTerminal(webview: vscode.Webview, extensionUri: vscode.Uri, xtermRoot: vscode.Uri, server: SshServer): string {
	const nonce = createNonce();
	const xtermCssUri = webview.asWebviewUri(vscode.Uri.joinPath(xtermRoot, 'xterm.css'));
	const xtermJsUri = webview.asWebviewUri(vscode.Uri.joinPath(xtermRoot, 'xterm.js'));
	const fitAddonJsUri = webview.asWebviewUri(vscode.Uri.joinPath(xtermRoot, 'addon-fit.js'));
	const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(codiconsDistUri(extensionUri), 'codicon.css'));
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
	<link rel="stylesheet" href="${xtermCssUri}">
	<link rel="stylesheet" href="${codiconsUri}">
	<title>${escapeHtml(server.name)}</title>
	<style>
		:root { color-scheme: light dark; }
		* { box-sizing: border-box; }
		html, body { width: 100%; height: 100%; margin: 0; padding:0 4px; overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
		body { display: grid; grid-template-rows: auto minmax(0, 1fr); }
		.metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); height: 34px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
		.metric { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; padding: 0 10px 0 13px; }
		.metric::before { position: absolute; left: 5px; width: 3px; height: 12px; border-radius: 2px; background: var(--metric-accent); content: ''; }
		.metric:nth-child(1) { --metric-accent: var(--vscode-charts-blue); }
		.metric:nth-child(2) { --metric-accent: var(--vscode-charts-green); }
		.metric:nth-child(3) { --metric-accent: var(--vscode-charts-yellow); }
		.metric:nth-child(4) { --metric-accent: var(--vscode-charts-purple); }
		.metric:last-child { border-right: 0; }
		.metric-label { flex: 0 0 auto; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 600; text-transform: uppercase; }
		.metric-value { min-width: 0; overflow: hidden; color: var(--vscode-foreground); font-family: var(--vscode-editor-font-family); font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
		.workspace { display: grid; grid-template-columns: minmax(0, 1fr); min-height: 0; }
		.workspace.sftp-visible { grid-template-columns: minmax(320px, 3fr) minmax(280px, 2fr); }
		.terminal-shell { position: relative; min-width: 0; min-height: 0; padding: 6px 0; }
		#terminal { width: 100%; height: 100%; }
		.sftp-panel { display: none; min-width: 0; min-height: 0; border-left: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); user-select: none; }
		.workspace.sftp-visible .sftp-panel { display: grid; grid-template-rows: 38px 30px minmax(0, 1fr); }
		.sftp-toolbar { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 6px; padding: 4px 0 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
		.icon-button { display: inline-grid; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 4px; place-items: center; color: var(--vscode-icon-foreground); background: transparent; cursor: pointer; }
		.icon-button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
		.icon-button:disabled { opacity: 0.4; cursor: default; }
		.sftp-path { width: 100%; min-width: 0; height: 26px; padding: 2px 6px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; outline: none; color: var(--vscode-input-foreground); background: var(--vscode-input-background); font-family: var(--vscode-editor-font-family); font-size: 12px; }
		.sftp-path:focus { border-color: var(--vscode-focusBorder); }
		.sftp-path:disabled { opacity: 0.6; cursor: default; }
		.sftp-header, .sftp-entry { display: grid; grid-template-columns: minmax(140px, 1fr) 86px 130px; align-items: center; }
		.sftp-header { padding: 0 12px; border-bottom: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); font-size: 11px; }
		.sftp-header span:not(:first-child), .sftp-meta { text-align: right; }
		.sftp-content { position: relative; min-height: 0; overflow: hidden; }
		.sftp-list { height: 100%; padding: 4px 0 4px 4px; overflow: auto; }
		.sftp-entry { min-height: 30px; padding: 0 6px; border-radius: 3px; cursor: default; }
		.sftp-entry:hover { color: var(--vscode-list-hoverForeground); background: var(--vscode-list-hoverBackground); }
		.sftp-name { display: flex; min-width: 0; align-items: center; gap: 7px; }
		.sftp-name .codicon { color: var(--vscode-symbolIcon-fileForeground, var(--vscode-icon-foreground)); }
		.sftp-name .folder { color: var(--vscode-symbolIcon-folderForeground, var(--vscode-icon-foreground)); }
		.sftp-name span:last-child, .sftp-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.sftp-meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
		.sftp-status { position: absolute; inset: 0; z-index: 1; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 24px; color: var(--vscode-descriptionForeground); font-size: 12px; text-align: center; }
		.sftp-status.loading { background: color-mix(in srgb, var(--vscode-editor-background) 65%, transparent); }
		.sftp-status .codicon { color: var(--vscode-progressBar-background); font-size: 16px; }
		.sftp-status[hidden] { display: none; }
		.connection-status { position: absolute; inset: 0; z-index: 2; display: flex; align-items: center; justify-content: center; pointer-events: none; }
		.connection-status[hidden] { display: none; }
		.status-content { display: grid; grid-template-columns: 18px auto; align-items: center; gap: 5px 12px; max-width: min(520px, calc(100% - 32px)); }
		.status-indicator { grid-row: 1 / 3; width: 16px; height: 16px; border: 2px solid color-mix(in srgb, var(--vscode-progressBar-background) 28%, transparent); border-top-color: var(--vscode-progressBar-background); border-radius: 50%; animation: status-spin 0.8s linear infinite; }
		.status-title { color: var(--vscode-foreground); font-size: 13px; font-weight: 500; }
		.status-detail { overflow: hidden; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
		.connection-status.error .status-indicator, .connection-status.closed .status-indicator { border: 0; background: currentColor; animation: none; }
		.connection-status.error { color: var(--vscode-errorForeground); }
		.connection-status.error .status-title { color: var(--vscode-errorForeground); }
		.connection-status.closed { color: var(--vscode-descriptionForeground); }
		@keyframes status-spin { to { transform: rotate(360deg); } }
		@media (max-width: 760px) { .workspace.sftp-visible { grid-template-columns: minmax(260px, 1fr) minmax(240px, 1fr); } .sftp-header, .sftp-entry { grid-template-columns: minmax(130px, 1fr) 80px; } .sftp-header span:last-child, .sftp-entry .sftp-meta:last-child { display: none; } }
		@media (max-width: 620px) { .metric { gap: 4px; padding-right: 6px; } .metric-label { font-size: 9px; } .metric-value { font-size: 11px; } }
	</style>
</head>
<body>
	<header class="metrics" aria-label="Remote server metrics">
		<div class="metric"><span class="metric-label">CPU</span><span id="cpuMetric" class="metric-value">--</span></div>
		<div class="metric"><span class="metric-label">Memory</span><span id="memoryMetric" class="metric-value">--</span></div>
		<div class="metric"><span class="metric-label">Disk</span><span id="diskMetric" class="metric-value">--</span></div>
		<div class="metric"><span class="metric-label">Network</span><span id="networkMetric" class="metric-value">--</span></div>
	</header>
	<main id="workspace" class="workspace">
		<section class="terminal-shell">
			<div id="connectionStatus" class="connection-status">
				<div class="status-content">
					<span class="status-indicator" aria-hidden="true"></span>
					<span id="statusTitle" class="status-title">Preparing terminal</span>
					<span id="statusDetail" class="status-detail">${escapeHtml(`${server.username}@${server.host}:${server.port}`)}</span>
				</div>
			</div>
			<div id="terminal" aria-label="SSH terminal"></div>
		</section>
		<aside class="sftp-panel" aria-label="SFTP file browser">
			<header class="sftp-toolbar">
				<button id="sftpUpButton" class="icon-button" type="button" title="Parent directory" aria-label="Parent directory"><i class="codicon codicon-arrow-up"></i></button>
				<input id="sftpPath" class="sftp-path" type="text" aria-label="Remote path" spellcheck="false">
				<button id="sftpRefreshButton" class="icon-button" type="button" title="Refresh" aria-label="Refresh"><i class="codicon codicon-refresh"></i></button>
			</header>
			<div class="sftp-header"><span>Name</span><span>Size</span><span>Modified</span></div>
			<div class="sftp-content">
				<div id="sftpList" class="sftp-list" role="listbox" aria-label="Remote files"></div>
				<div id="sftpStatus" class="sftp-status loading" role="status"><i class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></i><span>Loading...</span></div>
			</div>
		</aside>
	</main>
	<script nonce="${nonce}" src="${xtermJsUri}"></script>
	<script nonce="${nonce}" src="${fitAddonJsUri}"></script>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const workspace = document.getElementById('workspace');
		const terminalElement = document.getElementById('terminal');
		const statusElement = document.getElementById('connectionStatus');
		const statusTitle = document.getElementById('statusTitle');
		const statusDetail = document.getElementById('statusDetail');
		const sftpPath = document.getElementById('sftpPath');
		const sftpList = document.getElementById('sftpList');
		const sftpStatus = document.getElementById('sftpStatus');
		const sftpUpButton = document.getElementById('sftpUpButton');
		const sftpRefreshButton = document.getElementById('sftpRefreshButton');
		let currentSftpPath = '.';
		let parentSftpPath = null;
		const metrics = {
			cpu: document.getElementById('cpuMetric'),
			memory: document.getElementById('memoryMetric'),
			disk: document.getElementById('diskMetric'),
			network: document.getElementById('networkMetric')
		};
		const terminal = new Terminal({
			cursorBlink: true,
			fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-font-family'),
			fontSize: Number(getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-font-size').replace('px', '')) || 14,
			theme: terminalTheme(),
			scrollback: 5000
		});
		const fitAddon = new FitAddon.FitAddon();
		terminal.loadAddon(fitAddon);
		terminal.open(terminalElement);
		terminal.onData(data => vscode.postMessage({ type: 'input', data }));
		terminal.onResize(size => vscode.postMessage({ type: 'resize', rows: size.rows, columns: size.cols }));

		const resizeObserver = new ResizeObserver(() => fitTerminal());
		resizeObserver.observe(terminalElement);
		window.addEventListener('message', event => {
			const message = event.data;
			if (message.type === 'output') terminal.write(Uint8Array.from(atob(message.data), character => character.charCodeAt(0)));
			if (message.type === 'status') updateStatus(message.status, message.message);
			if (message.type === 'metrics') updateMetrics(message.metrics);
			if (message.type === 'metricsUnavailable') updateMetrics({ cpu: '--', memory: '--', disk: '--', network: '--' });
			if (message.type === 'showSftp') {
				workspace.classList.add('sftp-visible');
				requestAnimationFrame(fitTerminal);
			}
			if (message.type === 'hideSftp') {
				workspace.classList.remove('sftp-visible');
				requestAnimationFrame(fitTerminal);
			}
			if (message.type === 'sftpLoading') {
				sftpPath.disabled = true;
				showSftpStatus('Loading ' + message.path + '...', true);
			}
			if (message.type === 'sftpEntries') renderSftpEntries(message);
			if (message.type === 'sftpError') {
				sftpPath.disabled = false;
				sftpStatus.hidden = true;
			}
		});
		sftpUpButton.addEventListener('click', () => { if (parentSftpPath) loadSftp(parentSftpPath); });
		sftpRefreshButton.addEventListener('click', () => loadSftp(currentSftpPath));
		sftpPath.addEventListener('keydown', event => {
			if (event.key === 'Enter') {
				const remotePath = sftpPath.value.trim();
				if (remotePath) loadSftp(remotePath);
			}
			if (event.key === 'Escape') {
				sftpPath.value = currentSftpPath;
				sftpPath.blur();
			}
		});
		window.addEventListener('focus', () => terminal.focus());
		window.addEventListener('resize', fitTerminal);

		requestAnimationFrame(() => {
			fitTerminal();
			terminal.focus();
			vscode.postMessage({ type: 'ready' });
		});

		function fitTerminal() {
			if (terminalElement.clientWidth > 0 && terminalElement.clientHeight > 0) fitAddon.fit();
		}

		function updateStatus(status, message) {
			statusElement.className = 'connection-status ' + status;
			statusTitle.textContent = status === 'connecting' ? 'Connecting' : status === 'error' ? 'Connection failed' : status === 'closed' ? 'Connection closed' : 'Connected';
			statusDetail.textContent = message;
			statusElement.hidden = status === 'connected';
		}

		function updateMetrics(values) {
			metrics.cpu.textContent = values.cpu;
			metrics.memory.textContent = values.memory;
			metrics.disk.textContent = values.disk;
			metrics.network.textContent = values.network;
		}

		function loadSftp(remotePath) {
			vscode.postMessage({ type: 'sftpList', path: remotePath });
		}

		function renderSftpEntries(message) {
			currentSftpPath = message.path;
			parentSftpPath = message.parentPath;
			sftpPath.disabled = false;
			sftpPath.value = currentSftpPath;
			sftpPath.title = currentSftpPath;
			sftpUpButton.disabled = !parentSftpPath;
			sftpList.replaceChildren(...message.entries.map(createSftpEntry));
			sftpStatus.hidden = message.entries.length !== 0;
			if (message.entries.length === 0) showSftpStatus('This directory is empty.');
		}

		function createSftpEntry(entry) {
			const item = document.createElement('div');
			item.className = 'sftp-entry';
			item.setAttribute('role', 'option');
			const name = document.createElement('span');
			name.className = 'sftp-name';
			const icon = document.createElement('i');
			icon.className = 'codicon codicon-' + (entry.isDirectory ? 'folder folder' : 'file');
			const label = document.createElement('span');
			label.textContent = entry.name;
			name.append(icon, label);
			const size = document.createElement('span');
			size.className = 'sftp-meta';
			size.textContent = entry.isDirectory ? '' : formatFileSize(entry.size);
			const modified = document.createElement('span');
			modified.className = 'sftp-meta';
			modified.textContent = new Date(entry.modifiedAt).toLocaleString();
			item.append(name, size, modified);
			if (entry.isDirectory) item.addEventListener('dblclick', () => loadSftp(entry.path));
			return item;
		}

		function showSftpStatus(message, loading) {
			const label = document.createElement('span');
			label.textContent = message;
			sftpStatus.classList.toggle('loading', Boolean(loading));
			if (loading) {
				const icon = document.createElement('i');
				icon.className = 'codicon codicon-loading codicon-modifier-spin';
				icon.setAttribute('aria-hidden', 'true');
				sftpStatus.replaceChildren(icon, label);
			} else {
				sftpStatus.replaceChildren(label);
			}
			sftpStatus.hidden = false;
		}

		function formatFileSize(bytes) {
			if (bytes < 1024) return bytes + ' B';
			const units = ['KB', 'MB', 'GB', 'TB'];
			let value = bytes / 1024;
			let unit = units[0];
			for (let index = 1; index < units.length && value >= 1024; index++) { value /= 1024; unit = units[index]; }
			return value.toFixed(value >= 10 ? 0 : 1) + ' ' + unit;
		}

		function terminalTheme() {
			const style = getComputedStyle(document.documentElement);
			return {
				background: style.getPropertyValue('--vscode-editor-background').trim(),
				foreground: style.getPropertyValue('--vscode-terminal-foreground').trim() || style.getPropertyValue('--vscode-editor-foreground').trim(),
				cursor: style.getPropertyValue('--vscode-terminalCursor-foreground').trim(),
				selectionBackground: style.getPropertyValue('--vscode-terminal-selectionBackground').trim()
			};
		}
	</script>
</body>
</html>`;
}
