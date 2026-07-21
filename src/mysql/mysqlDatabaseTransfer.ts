import { createWriteStream } from 'node:fs';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { Connection, RowDataPacket } from 'mysql2/promise';
import { MysqlServer } from '../servers/server';
import { createMysqlConnection } from './mysqlConnection';
import { splitMysqlStatements } from './sqlStatements';

export async function exportMysqlDatabase(
	server: MysqlServer,
	password: string,
	database: string,
): Promise<boolean> {
	const target = await vscode.window.showSaveDialog({
		filters: { SQL: ['sql'] },
		defaultUri: vscode.Uri.joinPath(vscode.Uri.file(homedir()), `${sanitizeFileName(database)}.sql`),
		saveLabel: 'Export',
	});
	if (!target) {
		return false;
	}

	try {
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: `Exporting database ${database}`,
		}, progress => writeDatabaseDump(server, password, database, target.fsPath, progress));
	} catch (error) {
		try {
			await vscode.workspace.fs.delete(target);
		} catch {
			// The output may not have been created yet.
		}
		throw error;
	}
	void vscode.window.showInformationMessage(`Exported database “${database}”.`);
	return true;
}

export async function importMysqlDatabase(
	server: MysqlServer,
	password: string,
	database: string,
): Promise<boolean> {
	const selection = await vscode.window.showOpenDialog({
		canSelectMany: false,
		filters: { SQL: ['sql'] },
		openLabel: 'Import',
	});
	if (!selection?.[0]) {
		return false;
	}

	const contents = await vscode.workspace.fs.readFile(selection[0]);
	const statements = splitMysqlStatements(Buffer.from(contents).toString('utf8'));
	if (statements.length === 0) {
		throw new Error('The selected file contains no executable SQL statements.');
	}
	const connection = await createMysqlConnection(server, password, database);
	try {
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: `Importing into database ${database}`,
		}, async progress => {
			for (let index = 0; index < statements.length; index++) {
				progress.report({ message: `Statement ${index + 1} of ${statements.length}` });
				try {
					await connection.query(statements[index]);
				} catch (error) {
					throw new Error(`Statement ${index + 1} failed: ${errorMessage(error)}`);
				}
			}
		});
	} finally {
		await connection.end();
	}
	void vscode.window.showInformationMessage(`Imported SQL into database “${database}”.`);
	return true;
}

async function writeDatabaseDump(
	server: MysqlServer,
	password: string,
	database: string,
	outputPath: string,
	progress: vscode.Progress<{ message?: string }>,
): Promise<void> {
	const connection = await createMysqlConnection(server, password, database);
	const output = createWriteStream(outputPath, { encoding: 'utf8' });
	const outputError = new Promise<never>((_, reject) => output.once('error', reject));
	try {
		await Promise.race([dumpDatabase(connection, database, output, progress), outputError]);
		output.end();
		await Promise.race([
			new Promise<void>(resolve => output.once('finish', resolve)),
			outputError,
		]);
	} finally {
		output.destroy();
		await connection.end();
	}
}

async function dumpDatabase(
	connection: Connection,
	database: string,
	output: NodeJS.WritableStream,
	progress: vscode.Progress<{ message?: string }>,
): Promise<void> {
	await writeSql(output, [
		'-- ServerHub MySQL database export',
		`-- Database: ${database}`,
		`-- Generated: ${new Date().toISOString()}`,
		'',
		'SET NAMES utf8mb4;',
		'SET FOREIGN_KEY_CHECKS = 0;',
		'SET UNIQUE_CHECKS = 0;',
		'',
	].join('\n'));

	const [objectRows] = await connection.query<RowDataPacket[]>(
		`SELECT TABLE_NAME AS name, TABLE_TYPE AS type
		FROM information_schema.TABLES
		WHERE TABLE_SCHEMA = ?
		ORDER BY TABLE_TYPE = 'VIEW', TABLE_NAME`,
		[database],
	);
	const tables = objectRows.filter(row => row.type === 'BASE TABLE').map(row => String(row.name));
	const views = objectRows.filter(row => row.type === 'VIEW').map(row => String(row.name));

	for (const table of tables) {
		progress.report({ message: `Structure: ${table}` });
		const [rows] = await connection.query<RowDataPacket[]>('SHOW CREATE TABLE ??', [table]);
		const createSql = String(rows[0]?.['Create Table'] ?? '');
		await writeSql(output, `DROP TABLE IF EXISTS ${connection.escapeId(table)};\n${createSql};\n\n`);
	}

	for (const table of tables) {
		progress.report({ message: `Data: ${table}` });
		await dumpTableData(connection, table, output);
	}

	for (const view of views) {
		progress.report({ message: `View: ${view}` });
		const [rows] = await connection.query<RowDataPacket[]>('SHOW CREATE VIEW ??', [view]);
		const createSql = String(rows[0]?.['Create View'] ?? '');
		await writeSql(output, `DROP VIEW IF EXISTS ${connection.escapeId(view)};\n${createSql};\n\n`);
	}

	await dumpDatabaseObjects(connection, database, 'TRIGGERS', 'TRIGGER_NAME', 'TRIGGER', 'SQL Original Statement', output, progress);
	await dumpRoutines(connection, database, 'PROCEDURE', output, progress);
	await dumpRoutines(connection, database, 'FUNCTION', output, progress);
	await dumpDatabaseObjects(connection, database, 'EVENTS', 'EVENT_NAME', 'EVENT', 'Create Event', output, progress);
	await writeSql(output, 'SET UNIQUE_CHECKS = 1;\nSET FOREIGN_KEY_CHECKS = 1;\n');
}

async function dumpTableData(
	connection: Connection,
	table: string,
	output: NodeJS.WritableStream,
): Promise<void> {
	const pageSize = 500;
	let offset = 0;
	while (true) {
		const [rows, fields] = await connection.query<RowDataPacket[]>('SELECT * FROM ?? LIMIT ? OFFSET ?', [table, pageSize, offset]);
		if (rows.length === 0) {
			return;
		}
		const columns = fields.map(field => connection.escapeId(field.name)).join(', ');
		const values = rows.map(row => `(${fields.map(field => connection.escape(row[field.name])).join(', ')})`).join(',\n');
		await writeSql(output, `INSERT INTO ${connection.escapeId(table)} (${columns}) VALUES\n${values};\n\n`);
		if (rows.length < pageSize) {
			return;
		}
		offset += pageSize;
	}
}

async function dumpRoutines(
	connection: Connection,
	database: string,
	type: 'PROCEDURE' | 'FUNCTION',
	output: NodeJS.WritableStream,
	progress: vscode.Progress<{ message?: string }>,
): Promise<void> {
	const [rows] = await connection.query<RowDataPacket[]>(
		`SELECT ROUTINE_NAME AS name FROM information_schema.ROUTINES
		WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = ? ORDER BY ROUTINE_NAME`,
		[database, type],
	);
	for (const row of rows) {
		const name = String(row.name);
		progress.report({ message: `${type === 'PROCEDURE' ? 'Procedure' : 'Function'}: ${name}` });
		const [createRows] = await connection.query<RowDataPacket[]>(`SHOW CREATE ${type} ??`, [name]);
		await writeDelimitedObject(connection, type, name, String(createRows[0]?.[`Create ${type === 'PROCEDURE' ? 'Procedure' : 'Function'}`] ?? ''), output);
	}
}

async function dumpDatabaseObjects(
	connection: Connection,
	database: string,
	informationSchemaTable: 'TRIGGERS' | 'EVENTS',
	nameColumn: 'TRIGGER_NAME' | 'EVENT_NAME',
	type: 'TRIGGER' | 'EVENT',
	createColumn: string,
	output: NodeJS.WritableStream,
	progress: vscode.Progress<{ message?: string }>,
): Promise<void> {
	const schemaColumn = type === 'TRIGGER' ? 'TRIGGER_SCHEMA' : 'EVENT_SCHEMA';
	const [rows] = await connection.query<RowDataPacket[]>(
		`SELECT ${nameColumn} AS name FROM information_schema.${informationSchemaTable} WHERE ${schemaColumn} = ? ORDER BY ${nameColumn}`,
		[database],
	);
	for (const row of rows) {
		const name = String(row.name);
		progress.report({ message: `${type === 'TRIGGER' ? 'Trigger' : 'Event'}: ${name}` });
		const [createRows] = await connection.query<RowDataPacket[]>(`SHOW CREATE ${type} ??`, [name]);
		await writeDelimitedObject(connection, type, name, String(createRows[0]?.[createColumn] ?? ''), output);
	}
}

async function writeDelimitedObject(
	connection: Connection,
	type: 'TRIGGER' | 'PROCEDURE' | 'FUNCTION' | 'EVENT',
	name: string,
	createSql: string,
	output: NodeJS.WritableStream,
): Promise<void> {
	await writeSql(output, `DROP ${type} IF EXISTS ${connection.escapeId(name)};\nDELIMITER ;;\n${createSql} ;;\nDELIMITER ;\n\n`);
}

function writeSql(output: NodeJS.WritableStream, contents: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error): void => {
			output.off('drain', onDrain);
			reject(error);
		};
		const onDrain = (): void => {
			output.off('error', onError);
			resolve();
		};
		output.once('error', onError);
		if (output.write(contents)) {
			output.off('error', onError);
			resolve();
		} else {
			output.once('drain', onDrain);
		}
	});
}

function sanitizeFileName(fileName: string): string {
	return fileName.replace(/[\\/:*?"<>|]/g, '-');
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}