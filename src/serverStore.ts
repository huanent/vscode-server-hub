import * as vscode from 'vscode';
import { ExportedSshServer, SshServer } from './server';

const serversStateKey = 'server-hub.servers';

export class ServerStore {
	constructor(private readonly context: vscode.ExtensionContext) {}

	enableSettingsSync(): void {
		this.context.globalState.setKeysForSync([serversStateKey]);
	}

	getServers(): SshServer[] {
		return this.context.globalState.get<SshServer[]>(serversStateKey, []);
	}

	async saveServer(server: SshServer, password?: string): Promise<void> {
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

	async getExportedServers(): Promise<ExportedSshServer[]> {
		return Promise.all(this.getServers().map(async server => ({
			...server,
			password: await this.getPassword(server.id) ?? '',
		})));
	}

	async importServers(importedServers: ExportedSshServer[]): Promise<void> {
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