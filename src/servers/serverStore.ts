import * as vscode from 'vscode';
import { ExportedServer, parseStoredServers, Server } from './server';

const serversStateKey = 'server-hub.servers';

export interface ServerCredentials {
	password?: string;
	privateKey?: string;
	passphrase?: string;
}

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

	async saveServer(server: Server, credentials: ServerCredentials = {}): Promise<void> {
		const servers = this.getServers();
		const exists = servers.some(current => current.id === server.id);
		const updatedServers = exists
			? servers.map(current => current.id === server.id ? server : current)
			: [...servers, server];
		await this.context.globalState.update(serversStateKey, updatedServers);
		await this.saveCredentials(server, credentials, false);
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
		await Promise.all(serverIds.flatMap(serverId => [
			this.context.secrets.delete(passwordKey(serverId)),
			this.context.secrets.delete(privateKeyKey(serverId)),
			this.context.secrets.delete(passphraseKey(serverId)),
		]));
		this.changeEmitter.fire();
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
		await this.context.globalState.update(serversStateKey, updatedServers);
		await Promise.all(importedServers.map(server => this.saveCredentials(server, server, true)));
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