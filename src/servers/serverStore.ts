import { watch, FSWatcher } from 'node:fs';
import * as vscode from 'vscode';
import { ExportedServer, parseStoredServers, Server } from './server';

const serversStateKey = 'server-hub.servers';
const serversFileName = 'servers.json';

export interface ServerCredentials {
	password?: string;
	privateKey?: string;
	passphrase?: string;
}

export type ServerMoveDirection = 'up' | 'down';

export class ServerStore {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changeEmitter.event;
	private readonly serversUri: vscode.Uri;
	private servers: Server[] = [];
	private watcher: FSWatcher | undefined;
	private reloadTimer: NodeJS.Timeout | undefined;

	private constructor(private readonly context: vscode.ExtensionContext) {
		this.serversUri = vscode.Uri.joinPath(context.globalStorageUri, serversFileName);
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
		await this.writeServers(updatedServers);
		await this.saveCredentials(server, credentials, false);
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
		await this.writeServers(
			this.getServers().filter(server => !deletedIds.has(server.id)),
		);
		await Promise.all(serverIds.flatMap(serverId => [
			this.context.secrets.delete(passwordKey(serverId)),
			this.context.secrets.delete(privateKeyKey(serverId)),
			this.context.secrets.delete(passphraseKey(serverId)),
		]));
	}

	getPassword(serverId: string): Thenable<string | undefined> {
		return this.context.secrets.get(passwordKey(serverId));
	}

	async getCredentials(serverId: string): Promise<ServerCredentials> {
		const [password, privateKey, passphrase] = await Promise.all([
			this.context.secrets.get(passwordKey(serverId)),
			this.context.secrets.get(privateKeyKey(serverId)),
			this.context.secrets.get(passphraseKey(serverId)),
		]);
		return { password, privateKey, passphrase };
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
		await this.writeServers(updatedServers);
		await Promise.all(importedServers.map(server => this.saveCredentials(server, server, true)));
	}

	private async initialize(): Promise<void> {
		await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
		this.watcher = watch(this.context.globalStorageUri.fsPath, (_eventType, fileName) => {
			if (fileName === serversFileName) {
				this.scheduleReload();
			}
		});
		try {
			await this.reloadServers();
		} catch (error) {
			if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
				throw error;
			}
			await this.writeServers(parseStoredServers(this.context.globalState.get<unknown>(serversStateKey, [])));
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
		const content = await vscode.workspace.fs.readFile(this.serversUri);
		const servers = parseStoredServers(JSON.parse(Buffer.from(content).toString('utf8')));
		if (JSON.stringify(servers) === JSON.stringify(this.servers)) {
			return;
		}
		this.servers = servers;
		this.changeEmitter.fire();
	}

	private async writeServers(servers: Server[]): Promise<void> {
		const temporaryUri = vscode.Uri.joinPath(
			this.context.globalStorageUri,
			`${serversFileName}.${process.pid}.${Date.now()}.tmp`,
		);
		await vscode.workspace.fs.writeFile(temporaryUri, Buffer.from(JSON.stringify(servers, undefined, 2)));
		await vscode.workspace.fs.rename(temporaryUri, this.serversUri, { overwrite: true });
		this.servers = servers;
		this.changeEmitter.fire();
	}

	private async saveCredentials(server: Server, credentials: ServerCredentials, replace: boolean): Promise<void> {
		if (server.type === 'ssh' && server.authType === 'privateKey') {
			await this.context.secrets.delete(passwordKey(server.id));
			if (credentials.privateKey) {
				await this.context.secrets.store(privateKeyKey(server.id), credentials.privateKey);
			} else if (replace) {
				await this.context.secrets.delete(privateKeyKey(server.id));
			}
			if (credentials.passphrase) {
				await this.context.secrets.store(passphraseKey(server.id), credentials.passphrase);
			} else if (replace || credentials.passphrase !== undefined) {
				await this.context.secrets.delete(passphraseKey(server.id));
			}
			return;
		}

		await Promise.all([
			this.context.secrets.delete(privateKeyKey(server.id)),
			this.context.secrets.delete(passphraseKey(server.id)),
		]);
		if (credentials.password) {
			await this.context.secrets.store(passwordKey(server.id), credentials.password);
		} else if (replace) {
			await this.context.secrets.delete(passwordKey(server.id));
		}
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