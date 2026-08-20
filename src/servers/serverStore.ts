import { watch, FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import * as vscode from 'vscode';
import { ExportedServer, parseStoredServers, Server, usesPrivateKey } from './server';

const serversStateKey = 'server-hub.servers';
const serversFileName = 'servers.json';
const serverStoragePathSetting = 'serverStoragePath';
const serverFilePattern = /^\d{6}-.+\.json$/;

export interface ServerCredentials {
	password?: string;
	privateKey?: string;
	passphrase?: string;
}

export type ServerMoveDirection = 'up' | 'down';

export class ServerStore {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changeEmitter.event;
	private readonly serversDirectoryUri: vscode.Uri;
	private servers: Server[] = [];
	private readonly credentials = new Map<string, ServerCredentials>();
	private watcher: FSWatcher | undefined;
	private reloadTimer: NodeJS.Timeout | undefined;

	private constructor(private readonly context: vscode.ExtensionContext) {
		this.serversDirectoryUri = getServersDirectoryUri(context);
	}

	static async create(context: vscode.ExtensionContext): Promise<ServerStore> {
		const store = new ServerStore(context);
		await store.initialize();
		return store;
	}

	getServers(): Server[] {
		return this.servers;
	}

	getGroups(): string[] {
		return [...new Set(this.getServers().map(server => server.group).filter(Boolean))]
			.sort((left, right) => left.localeCompare(right));
	}

	async saveServer(server: Server, credentials: ServerCredentials = {}): Promise<void> {
		const servers = this.getServers();
		const exists = servers.some(current => current.id === server.id);
		const updatedServers = exists
			? servers.map(current => current.id === server.id ? server : current)
			: [...servers, server];
		this.saveCredentials(server, credentials, false);
		await this.writeServers(updatedServers);
	}

	async renameGroup(group: string, newGroup: string): Promise<void> {
		await this.writeServers(
			this.getServers().map(server => server.group === group ? { ...server, group: newGroup } : server),
		);
	}

	async moveServer(serverId: string, direction: ServerMoveDirection): Promise<void> {
		const servers = [...this.getServers()];
		const serverIndex = servers.findIndex(server => server.id === serverId);
		if (serverIndex < 0) {
			return;
		}

		const step = direction === 'up' ? -1 : 1;
		let targetIndex = serverIndex + step;
		while (targetIndex >= 0 && targetIndex < servers.length && servers[targetIndex].group !== servers[serverIndex].group) {
			targetIndex += step;
		}
		if (targetIndex < 0 || targetIndex >= servers.length) {
			return;
		}

		[servers[serverIndex], servers[targetIndex]] = [servers[targetIndex], servers[serverIndex]];
		await this.writeServers(servers);
	}

	async moveGroup(group: string, direction: ServerMoveDirection): Promise<void> {
		const servers = this.getServers();
		const groups = [...new Set(servers.map(server => server.group).filter(Boolean))];
		const groupIndex = groups.indexOf(group);
		const targetIndex = groupIndex + (direction === 'up' ? -1 : 1);
		if (groupIndex < 0 || targetIndex < 0 || targetIndex >= groups.length) {
			return;
		}

		[groups[groupIndex], groups[targetIndex]] = [groups[targetIndex], groups[groupIndex]];
		await this.writeServers([
			...groups.flatMap(currentGroup => servers.filter(server => server.group === currentGroup)),
			...servers.filter(server => !server.group),
		]);
	}

	async deleteServer(serverId: string): Promise<void> {
		await this.deleteServers([serverId]);
	}

	async deleteServers(serverIds: string[]): Promise<void> {
		const deletedIds = new Set(serverIds);
		serverIds.forEach(serverId => this.credentials.delete(serverId));
		await this.writeServers(
			this.getServers().filter(server => !deletedIds.has(server.id)),
		);
	}

	getPassword(serverId: string): Thenable<string | undefined> {
		return Promise.resolve(this.credentials.get(serverId)?.password);
	}

	async getCredentials(serverId: string): Promise<ServerCredentials> {
		return { ...this.credentials.get(serverId) };
	}

	async getExportedServers(): Promise<ExportedServer[]> {
		return Promise.all(this.getServers().map(async server => {
			const credentials = await this.getCredentials(server.id);
			return {
				...server,
				password: credentials.password ?? '',
				privateKey: credentials.privateKey,
				passphrase: credentials.passphrase,
			};
		}));
	}

	async importServers(importedServers: ExportedServer[]): Promise<void> {
		const importedIds = new Set(importedServers.map(server => server.id));
		const updatedServers = [
			...this.getServers().filter(server => !importedIds.has(server.id)),
			...importedServers.map(({ password: _password, privateKey: _privateKey, passphrase: _passphrase, ...server }) => server),
		];
		importedServers.forEach(server => this.saveCredentials(server, server, true));
		await this.writeServers(updatedServers);
	}

	private async initialize(): Promise<void> {
		await vscode.workspace.fs.createDirectory(this.serversDirectoryUri);
		this.watcher = watch(this.serversDirectoryUri.fsPath, (_eventType, fileName) => {
			if (fileName?.endsWith('.json')) {
				this.scheduleReload();
			}
		});
		await this.reloadServers();
		if (this.servers.length === 0) {
			this.servers = await this.readLegacyServers();
		}
		if (await this.migrateSecretCredentials()) {
			await this.writeServers(this.servers);
			await this.deleteSecretCredentials();
		} else if (this.servers.length > 0 && !(await this.hasServerFiles())) {
			await this.writeServers(this.servers);
		}
	}

	private scheduleReload(): void {
		if (this.reloadTimer) {
			clearTimeout(this.reloadTimer);
		}
		this.reloadTimer = setTimeout(() => {
			this.reloadTimer = undefined;
			void this.reloadServers().catch(() => undefined);
		}, 50);
	}

	private async reloadServers(): Promise<void> {
		const entries = await vscode.workspace.fs.readDirectory(this.serversDirectoryUri);
		const serverFiles = entries
			.filter(([name, type]) => type === vscode.FileType.File && serverFilePattern.test(name))
			.map(([name]) => name)
			.sort();
		const storedServers = (await Promise.all(serverFiles.map(async name => {
			try {
				const content = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.serversDirectoryUri, name));
				return parseStoredServer(JSON.parse(Buffer.from(content).toString('utf8')));
			} catch {
				return undefined;
			}
		}))).filter((storedServer): storedServer is StoredServer => storedServer !== undefined);
		const servers = storedServers.map(({ server }) => server);
		const credentials = new Map(storedServers
			.filter(({ hasCredentials }) => hasCredentials)
			.map(({ server, credentials }) => [server.id, credentials]));
		if (JSON.stringify(servers) === JSON.stringify(this.servers)
			&& JSON.stringify([...credentials]) === JSON.stringify([...this.credentials])) {
			return;
		}
		this.servers = servers;
		this.credentials.clear();
		credentials.forEach((value, key) => this.credentials.set(key, value));
		this.changeEmitter.fire();
	}

	private async writeServers(servers: Server[]): Promise<void> {
		const existingEntries = await vscode.workspace.fs.readDirectory(this.serversDirectoryUri);
		const expectedFiles = new Set(servers.map((server, index) => serverFileName(server, index)));
		await Promise.all(servers.map(async (server, index) => {
			const fileName = serverFileName(server, index);
			const serverUri = vscode.Uri.joinPath(this.serversDirectoryUri, fileName);
			const temporaryUri = vscode.Uri.joinPath(this.serversDirectoryUri, `${fileName}.${process.pid}.${Date.now()}.tmp`);
			const credentials = this.credentials.get(server.id) ?? {};
			await vscode.workspace.fs.writeFile(temporaryUri, Buffer.from(JSON.stringify({
				...server,
				password: credentials.password ?? '',
				privateKey: credentials.privateKey ?? '',
				passphrase: credentials.passphrase ?? '',
			}, undefined, 2)));
			await vscode.workspace.fs.rename(temporaryUri, serverUri, { overwrite: true });
		}));
		await Promise.all(existingEntries
			.map(([name, type]) => ({ name, type }))
			.filter(({ name, type }) => type === vscode.FileType.File && serverFilePattern.test(name) && !expectedFiles.has(name))
			.map(({ name }) => vscode.workspace.fs.delete(vscode.Uri.joinPath(this.serversDirectoryUri, name))));
		this.servers = servers;
		this.changeEmitter.fire();
	}

	private async readLegacyServers(): Promise<Server[]> {
		try {
			const content = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.context.globalStorageUri, serversFileName));
			return parseStoredServers(JSON.parse(Buffer.from(content).toString('utf8')));
		} catch (error) {
			if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
				throw error;
			}
			return parseStoredServers(this.context.globalState.get<unknown>(serversStateKey, []));
		}
	}

	private async hasServerFiles(): Promise<boolean> {
		const entries = await vscode.workspace.fs.readDirectory(this.serversDirectoryUri);
		return entries.some(([name, type]) => type === vscode.FileType.File && serverFilePattern.test(name));
	}

	private async migrateSecretCredentials(): Promise<boolean> {
		let changed = false;
		await Promise.all(this.servers.map(async server => {
			if (server.type === 'container' && (server.connectionType === 'local' || server.sshServerId)) {
				return;
			}
			const current = this.credentials.get(server.id) ?? {};
			const [password, privateKey, passphrase] = await Promise.all([
				current.password ? undefined : this.context.secrets.get(passwordKey(server.id)),
				current.privateKey ? undefined : this.context.secrets.get(privateKeyKey(server.id)),
				current.passphrase ? undefined : this.context.secrets.get(passphraseKey(server.id)),
			]);
			if (!password && !privateKey && !passphrase) {
				return;
			}
			this.saveCredentials(server, {
				password: current.password || password,
				privateKey: current.privateKey || privateKey,
				passphrase: current.passphrase || passphrase,
			}, true);
			changed = true;
		}));
		return changed;
	}

	private async deleteSecretCredentials(): Promise<void> {
		await Promise.all(this.servers.flatMap(server => [
			this.context.secrets.delete(passwordKey(server.id)),
			this.context.secrets.delete(privateKeyKey(server.id)),
			this.context.secrets.delete(passphraseKey(server.id)),
		]));
	}

	private saveCredentials(server: Server, credentials: ServerCredentials, replace: boolean): void {
		if (server.type === 'container' && (server.connectionType === 'local' || server.sshServerId)) {
			this.credentials.set(server.id, {});
			return;
		}
		const current = this.credentials.get(server.id) ?? {};
		if (usesPrivateKey(server)) {
			this.credentials.set(server.id, {
				privateKey: credentials.privateKey || (replace ? undefined : current.privateKey),
				passphrase: credentials.passphrase || (replace || credentials.passphrase !== undefined ? undefined : current.passphrase),
			});
			return;
		}

		this.credentials.set(server.id, {
			password: credentials.password || (replace ? undefined : current.password),
		});
	}

	dispose(): void {
		this.watcher?.close();
		if (this.reloadTimer) {
			clearTimeout(this.reloadTimer);
		}
		this.changeEmitter.dispose();
	}
}

function passwordKey(serverId: string): string {
	return `server-hub.password.${serverId}`;
}

function privateKeyKey(serverId: string): string {
	return `server-hub.privateKey.${serverId}`;
}

function passphraseKey(serverId: string): string {
	return `server-hub.passphrase.${serverId}`;
}

function getServersDirectoryUri(context: vscode.ExtensionContext): vscode.Uri {
	const configuration = vscode.workspace.getConfiguration('server-hub');
	const configuredPath = configuration.inspect<string>(serverStoragePathSetting)?.globalValue?.trim() ?? '';
	if (!configuredPath) {
		return vscode.Uri.joinPath(context.globalStorageUri, 'servers');
	}

	const expandedPath = configuredPath === '~'
		? homedir()
		: configuredPath.startsWith('~/') || configuredPath.startsWith('~\\')
			? resolve(homedir(), configuredPath.slice(2))
			: configuredPath;
	return vscode.Uri.file(isAbsolute(expandedPath) ? expandedPath : resolve(homedir(), expandedPath));
}

function serverFileName(server: Server, index: number): string {
	return `${String(index).padStart(6, '0')}-${encodeURIComponent(server.id)}.json`;
}

interface StoredServer {
	server: Server;
	credentials: ServerCredentials;
	hasCredentials: boolean;
}

function parseStoredServer(value: unknown): StoredServer | undefined {
	const server = parseStoredServers([value])[0];
	if (!server || typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	return {
		server,
		credentials: {
			password: typeof record.password === 'string' ? record.password : undefined,
			privateKey: typeof record.privateKey === 'string' ? record.privateKey : undefined,
			passphrase: typeof record.passphrase === 'string' ? record.passphrase : undefined,
		},
		hasCredentials: 'password' in record || 'privateKey' in record || 'passphrase' in record,
	};
}