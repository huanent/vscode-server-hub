import * as vscode from 'vscode';
import { ExportedServer, parseStoredServers, Server } from './server';

const serversStateKey = 'server-hub.servers';

export class ServerStore {
	constructor(private readonly context: vscode.ExtensionContext) {}

	enableSettingsSync(): void {
		this.context.globalState.setKeysForSync([serversStateKey]);
		const storedServers = this.context.globalState.get<unknown>(serversStateKey, []);
		const normalizedServers = parseStoredServers(storedServers);
		if (JSON.stringify(storedServers) !== JSON.stringify(normalizedServers)) {
			void this.context.globalState.update(serversStateKey, normalizedServers);
		}
	}

	getServers(): Server[] {
		return parseStoredServers(this.context.globalState.get<unknown>(serversStateKey, []));
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
	}

	async deleteServer(serverId: string): Promise<void> {
		await this.context.globalState.update(
			serversStateKey,
			this.getServers().filter(server => server.id !== serverId),
		);
		await this.context.secrets.delete(passwordKey(serverId));
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
	}
}

function passwordKey(serverId: string): string {
	return `server-hub.password.${serverId}`;
}