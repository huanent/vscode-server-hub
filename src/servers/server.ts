export type ServerType = 'ssh' | 'mysql' | 'container';

export interface BaseServer {
	id: string;
	type: ServerType;
	name: string;
	group: string;
}

export interface NetworkServer extends BaseServer {
	host: string;
	port: number;
	username: string;
}

export interface SshServer extends NetworkServer {
	type: 'ssh';
	authType: 'password' | 'privateKey';
}

export interface MysqlServer extends NetworkServer {
	type: 'mysql';
	database: string;
}

export interface ContainerServer extends BaseServer {
	type: 'container';
	runtime: 'docker' | 'podman' | 'apple';
	executablePath: string;
}

export type Server = SshServer | MysqlServer | ContainerServer;

export type ExportedServer = Server & {
	password: string;
	privateKey?: string;
	passphrase?: string;
};

export interface ServerExportFile {
	version: 5;
	servers: ExportedServer[];
}

export interface ServerFormMessage {
	type: 'save' | 'selectPrivateKey' | 'selectExecutable';
	name?: unknown;
	group?: unknown;
	host?: unknown;
	port?: unknown;
	username?: unknown;
	authType?: unknown;
	password?: unknown;
	privateKey?: unknown;
	passphrase?: unknown;
	database?: unknown;
	runtime?: unknown;
	executablePath?: unknown;
}

export function parseServerForm(
	message: ServerFormMessage,
	serverType: ServerType,
	serverId?: string,
): Server | undefined {
	const name = normalizeString(message.name);
	const group = normalizeString(message.group);
	if (!name) {
		return undefined;
	}
	if (serverType === 'container') {
		const runtime = message.runtime === 'podman' ? 'podman' : message.runtime === 'apple' ? 'apple' : 'docker';
		const executablePath = normalizeString(message.executablePath);
		if (!executablePath) {
			return undefined;
		}
		return {
			id: serverId ?? crypto.randomUUID(),
			type: 'container',
			name,
			group,
			runtime,
			executablePath,
		};
	}

	const host = normalizeString(message.host);
	const username = normalizeString(message.username);
	const port = Number(message.port);
	if (!name || !host || !username || !Number.isInteger(port) || port < 1 || port > 65_535) {
		return undefined;
	}

	const baseServer = {
		id: serverId ?? crypto.randomUUID(),
		name,
		group,
		host,
		port,
		username,
	};
	if (serverType === 'mysql') {
		const database = normalizeString(message.database);
		if (!database) {
			return undefined;
		}
		return { ...baseServer, type: 'mysql', database };
	}

	return {
		...baseServer,
		type: 'ssh',
		authType: message.authType === 'privateKey' ? 'privateKey' : 'password',
	};
}

export function parseStoredServers(value: unknown): Server[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.flatMap(entry => {
		try {
			return [parseServer(entry, false)];
		} catch {
			return [];
		}
	});
}

export function parseServerExport(value: unknown): ExportedServer[] {
	if (!isRecord(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4 && value.version !== 5) || !Array.isArray(value.servers)) {
		throw new Error('The file is not a supported ServerHub export.');
	}

	const serverIds = new Set<string>();
	return value.servers.map((entry, index) => {
		if (!isRecord(entry) || typeof entry.password !== 'string') {
			throw new Error(`Server ${index + 1} is invalid.`);
		}

		let server: Server;
		try {
			server = parseServer(entry, value.version === 2);
		} catch {
			throw new Error(`Server ${index + 1} has invalid or missing fields.`);
		}
		if (serverIds.has(server.id)) {
			throw new Error(`Server ${index + 1} uses a duplicate ID.`);
		}
		if (server.type === 'ssh' && server.authType === 'privateKey' && typeof entry.privateKey !== 'string') {
			throw new Error(`Server ${index + 1} has no private key.`);
		}

		serverIds.add(server.id);
		return {
			...server,
			password: entry.password,
			privateKey: typeof entry.privateKey === 'string' ? entry.privateKey : undefined,
			passphrase: typeof entry.passphrase === 'string' ? entry.passphrase : undefined,
		};
	});
}

export function normalizePassword(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function parseServer(value: unknown, requireType: boolean): Server {
	if (!isRecord(value)) {
		throw new Error('Invalid server.');
	}

	const type = value.type === 'mysql'
		? 'mysql'
		: value.type === 'container'
			? 'container'
			: value.type === 'ssh' || !requireType ? 'ssh' : undefined;
	const id = normalizeString(value.id);
	if (!type || !id) {
		throw new Error('Invalid server.');
	}

	const server = parseServerForm({
		type: 'save',
		name: value.name,
		group: value.group,
		host: value.host,
		port: value.port,
		username: value.username,
		authType: value.authType,
		database: value.database,
		runtime: value.runtime,
		executablePath: value.executablePath,
	}, type, id);
	if (!server) {
		throw new Error('Invalid server.');
	}
	return server;
}

function normalizeString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}