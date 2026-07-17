export interface SshServer {
	id: string;
	name: string;
	host: string;
	port: number;
	username: string;
}

export interface ExportedSshServer extends SshServer {
	password: string;
}

export interface ServerExportFile {
	version: 1;
	servers: ExportedSshServer[];
}

export interface ServerFormMessage {
	type: 'save';
	name?: unknown;
	host?: unknown;
	port?: unknown;
	username?: unknown;
	password?: unknown;
}

export function parseServerForm(message: ServerFormMessage, serverId?: string): SshServer | undefined {
	const name = normalizeString(message.name);
	const host = normalizeString(message.host);
	const username = normalizeString(message.username);
	const port = Number(message.port);
	if (!name || !host || !username || !Number.isInteger(port) || port < 1 || port > 65_535) {
		return undefined;
	}

	return {
		id: serverId ?? crypto.randomUUID(),
		name,
		host,
		port,
		username,
	};
}

export function parseServerExport(value: unknown): ExportedSshServer[] {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.servers)) {
		throw new Error('The file is not a supported Server Hub export.');
	}

	const serverIds = new Set<string>();
	return value.servers.map((entry, index) => {
		if (!isRecord(entry)) {
			throw new Error(`Server ${index + 1} is invalid.`);
		}

		const id = normalizeString(entry.id);
		const server = parseServerForm({
			type: 'save',
			name: entry.name,
			host: entry.host,
			port: entry.port,
			username: entry.username,
		}, id);
		if (!id || !server || typeof entry.password !== 'string') {
			throw new Error(`Server ${index + 1} has invalid or missing fields.`);
		}
		if (serverIds.has(id)) {
			throw new Error(`Server ${index + 1} uses a duplicate ID.`);
		}

		serverIds.add(id);
		return { ...server, password: entry.password };
	});
}

export function normalizePassword(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function normalizeString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}