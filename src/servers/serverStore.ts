import * as vscode from 'vscode';
import { ExportedServer, parseStoredServers, Server } from './server';

const serversStateKey = 'server-hub.servers';

export class ServerStore {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changeEmitter.event;

	constructor(private readonly context: vscode.ExtensionContext) {}

	getServers(): Server[] {
		return parseStoredServers(this.context.globalState.get<unknown>(serversStateKey, []));
	}

	getGroups(): string[] {
		return [...new Set(this.getServers().map(server => server.group).filter(Boolean))]
			.sort((left, right) => left.localeCompare(right));
	}

	async saveServer(server: Server, password?: string): Promise<void> {
		const servers = this.getServers();
		const exists = servers.some(current => current.id === server.id);
		const updatedServers = exists
			? servers.map(current => current.id === server.id ? server : current)
			: [...servers, server];
		await this.context.globalState.update(serversStateKey, updatedServers);
		if (password) {
			await this.context.secrets.store(passwordKey(server.id), password);
		}
		this.changeEmitter.fire();
	}

	async deleteServer(serverId: string): Promise<void> {
		await this.deleteServers([serverId]);
	}

	async deleteServers(serverIds: string[]): Promise<void> {
		const deletedIds = new Set(serverIds);
		await this.context.globalState.update(
			serversStateKey,
			this.getServers().filter(server => !deletedIds.has(server.id)),
		);
		await Promise.all(serverIds.map(serverId => this.context.secrets.delete(passwordKey(serverId))));
		this.changeEmitter.fire();
	}

	getPassword(serverId: string): Thenable<string | undefined> {
		return this.context.secrets.get(passwordKey(serverId));
	}

	async getExportedServers(): Promise<ExportedServer[]> {
		return Promise.all(this.getServers().map(async server => ({
			...server,
			password: await this.getPassword(server.id) ?? '',
		})));
	}

	async importServers(importedServers: ExportedServer[]): Promise<void> {
		const importedIds = new Set(importedServers.map(server => server.id));
		const updatedServers = [
			...this.getServers().filter(server => !importedIds.has(server.id)),
			...importedServers.map(({ password: _password, ...server }) => server),
		];
		await this.context.globalState.update(serversStateKey, updatedServers);
		await Promise.all(importedServers.map(server => server.password
			? this.context.secrets.store(passwordKey(server.id), server.password)
			: this.context.secrets.delete(passwordKey(server.id))));
		this.changeEmitter.fire();
	}

	dispose(): void {
		this.changeEmitter.dispose();
	}
}

function passwordKey(serverId: string): string {
	return `server-hub.password.${serverId}`;
}