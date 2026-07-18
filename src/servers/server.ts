export type ServerType = 'ssh' | 'mysql';

export interface BaseServer {
	id: string;
	type: ServerType;
	name: string;
	group: string;
	host: string;
	port: number;
	username: string;
}

export interface SshServer extends BaseServer {
	type: 'ssh';
}

export interface MysqlServer extends BaseServer {
	type: 'mysql';
	database: string;
}

export type Server = SshServer | MysqlServer;

export type ExportedServer = Server & { password: string };

export interface ServerExportFile {
	version: 2;
	servers: ExportedServer[];
}

export interface ServerFormMessage {
	type: 'save';
	name?: unknown;
	group?: unknown;
	host?: unknown;
	port?: unknown;
	username?: unknown;
	password?: unknown;
	database?: unknown;
}

export function parseServerForm(
	message: ServerFormMessage,
	serverType: ServerType,
	serverId?: string,
): Server | undefined {
	const name = normalizeString(message.name);
	const group = normalizeString(message.group);
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

	return { ...baseServer, type: 'ssh' };
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
	if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || !Array.isArray(value.servers)) {
		throw new Error('The file is not a supported Server Hub export.');
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

		serverIds.add(server.id);
		return { ...server, password: entry.password };
	});
}

export function normalizePassword(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function parseServer(value: unknown, requireType: boolean): Server {
	if (!isRecord(value)) {
		throw new Error('Invalid server.');
	}

	const type = value.type === 'mysql' ? 'mysql' : value.type === 'ssh' || !requireType ? 'ssh' : undefined;
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
		database: value.database,
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