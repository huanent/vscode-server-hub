import { Connection, createConnection } from 'mysql2/promise';
import { MysqlServer } from '../servers/server';

export function createMysqlConnection(
	server: MysqlServer,
	password: string,
	database?: string,
): Promise<Connection> {
	return createConnection({
		host: server.host,
		port: server.port,
		user: server.username,
		password,
		database,
		connectTimeout: 15_000,
		dateStrings: true,
		supportBigNumbers: true,
		bigNumberStrings: true,
	});
}