import * as vscode from 'vscode';
import { Connection, FieldPacket, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
	MysqlColumnInfo,
	MysqlEditorMessage,
	MysqlTableFilter,
	MysqlTablePreviewMessage,
	MysqlTableSort,
} from './types';
import { createMysqlConnection } from './mysqlConnection';
import {
	buildTableFilterClause,
	displayMysqlValue,
	mysqlTablePageSizes,
	normalizeTableInfo,
	parseRowChanges,
	parseTableFilters,
	parseTableSort,
} from './tableData';
import { MysqlServer } from '../servers/server';
import { ServerCredentials } from '../servers/serverStore';
import { exportMysqlDatabase, importMysqlDatabase } from './mysqlDatabaseTransfer';
import { getWebviewHtml } from '../webview';

export function configureMysqlEditor(
	extensionUri: vscode.Uri,
	panel: vscode.WebviewPanel,
	server: MysqlServer,
	credentials: ServerCredentials,
	openTable: (database: string, table: string) => void,
	openSql: (database: string, initialSql?: string) => void,
): void {
	panel.title = server.name;
	panel.webview.options = {
		enableScripts: true,
		localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
	};
	panel.iconPath = new vscode.ThemeIcon('database');
	panel.webview.html = getWebviewHtml(panel.webview, extensionUri, 'mysqlOverview', server.name);

	let connection: Connection | undefined;
	let databases = new Set<string>();
	let tables = new Set<string>();
	let currentDatabase = server.database;
	let disposed = false;
	let pendingTableStatement: { id: string; database: string; sql: string } | undefined;

	panel.onDidDispose(() => {
		disposed = true;
		void connection?.end();
	});
	panel.webview.onDidReceiveMessage(async (message: MysqlEditorMessage) => {
		if (message.type === 'ready') {
			await panel.webview.postMessage({
				type: 'initialize',
				server: { name: server.name, address: `${server.username}@${server.host}:${server.port}`, database: server.database },
			});
			await connectAndLoad();
			return;
		}
		if (!connection) {
			return;
		}
		if (message.type === 'createDatabase') {
			await createDatabase();
			return;
		}
		if (message.type === 'deleteDatabase' && typeof message.database === 'string' && databases.has(message.database)) {
			await deleteDatabase(message.database);
			return;
		}
		if (message.type === 'importDatabase' && currentDatabase) {
			await importDatabase();
			return;
		}
		if (message.type === 'exportDatabase' && typeof message.database === 'string' && databases.has(message.database)) {
			await exportDatabase(message.database);
			return;
		}
		if (message.type === 'selectDatabase' && typeof message.database === 'string' && databases.has(message.database)) {
			currentDatabase = message.database;
			await loadTables();
			return;
		}
		if (message.type === 'refresh') {
			await loadTables();
			return;
		}
		if (message.type === 'openSql' && typeof message.database === 'string' && message.database === currentDatabase) {
			openSql(currentDatabase);
			return;
		}
		if (message.type === 'loadTableDefinition'
			&& message.database === currentDatabase
			&& typeof message.table === 'string'
			&& tables.has(message.table)) {
			await loadTableDefinition(message.table);
			return;
		}
		if (message.type === 'previewCreateTable' && typeof message.database === 'string' && message.database === currentDatabase) {
			previewCreateTable(message.definition);
			return;
		}
		if (message.type === 'previewAlterTable'
			&& message.database === currentDatabase
			&& typeof message.table === 'string'
			&& tables.has(message.table)) {
			await previewAlterTable(message.table, message.definition);
			return;
		}
		if (message.type === 'confirmTableStatement' && typeof message.confirmationId === 'string') {
			await confirmTableStatement(message.confirmationId);
			return;
		}
		if (
			message.type === 'deleteTable'
			&& typeof message.database === 'string'
			&& typeof message.table === 'string'
			&& message.database === currentDatabase
			&& tables.has(message.table)
		) {
			await deleteTable(message.table);
			return;
		}
		if (
			message.type === 'openTable'
			&& typeof message.database === 'string'
			&& typeof message.table === 'string'
			&& message.database === currentDatabase
			&& tables.has(message.table)
		) {
			openTable(currentDatabase, message.table);
		}
	});

	async function connectAndLoad(): Promise<void> {
		if (connection) {
			return;
		}
		try {
			connection = await createMysqlConnection(server, credentials);
			if (disposed) {
				await connection.end();
				return;
			}
			await loadDatabases();
			await loadTables();
		} catch (error) {
			void panel.webview.postMessage({ type: 'connectionError', message: errorMessage(error) });
		}
	}

	async function loadDatabases(preferredDatabase?: string): Promise<void> {
		if (!connection) {
			return;
		}
		const [rows] = await connection.query<RowDataPacket[]>(
			'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME',
		);
		databases = new Set(rows.map(row => String(row.name)));
		if (preferredDatabase && databases.has(preferredDatabase)) {
			currentDatabase = preferredDatabase;
		} else if (!databases.has(currentDatabase)) {
			currentDatabase = databases.values().next().value ?? '';
		}
		void panel.webview.postMessage({
			type: 'databases',
			databases: [...databases],
			selectedDatabase: currentDatabase,
			forceSelection: Boolean(preferredDatabase),
		});
	}

	async function createDatabase(): Promise<void> {
		if (!connection) {
			return;
		}
		const name = await vscode.window.showInputBox({
			title: 'Create MySQL Database',
			prompt: 'Enter a database name',
			validateInput: value => {
				const databaseName = value.trim();
				if (!databaseName) {
					return 'Database name is required';
				}
				if (Buffer.byteLength(databaseName, 'utf8') > 64) {
					return 'Database name must be 64 bytes or fewer';
				}
				if (databases.has(databaseName)) {
					return 'A database with this name already exists';
				}
				return undefined;
			},
		});
		const databaseName = name?.trim();
		if (!databaseName) {
			return;
		}
		try {
			await connection.query('CREATE DATABASE ?? CHARACTER SET utf8mb4', [databaseName]);
			await loadDatabases(databaseName);
			await loadTables();
			void vscode.window.showInformationMessage(`Created database “${databaseName}”.`);
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not create database: ${errorMessage(error)}`);
		}
	}

	async function deleteDatabase(database: string): Promise<void> {
		if (!connection) {
			return;
		}
		const confirmation = await vscode.window.showWarningMessage(
			`Delete database “${database}” and all of its data?`,
			{ modal: true },
			'Delete',
		);
		if (confirmation !== 'Delete') {
			return;
		}
		try {
			const deletingCurrentDatabase = database === currentDatabase;
			await connection.query('DROP DATABASE ??', [database]);
			await loadDatabases();
			if (deletingCurrentDatabase) {
				await loadTables();
			}
			void vscode.window.showInformationMessage(`Deleted database “${database}”.`);
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not delete database: ${errorMessage(error)}`);
		}
	}

	async function exportDatabase(database: string): Promise<void> {
		try {
			await exportMysqlDatabase(server, credentials, database);
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not export database: ${errorMessage(error)}`);
		}
	}

	async function importDatabase(): Promise<void> {
		const database = currentDatabase;
		try {
			const completed = await importMysqlDatabase(server, credentials, database);
			if (completed) {
				await loadTables();
			}
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not import database: ${errorMessage(error)}`);
		}
	}

	async function deleteTable(table: string): Promise<void> {
		if (!connection || !currentDatabase) {
			return;
		}
		const database = currentDatabase;
		const confirmation = await vscode.window.showWarningMessage(
			`Delete table “${database}.${table}” and all of its data?`,
			{ modal: true },
			'Delete',
		);
		if (confirmation !== 'Delete') {
			return;
		}
		try {
			await connection.query('DROP TABLE ??.??', [database, table]);
			await loadTables();
			void vscode.window.showInformationMessage(`Deleted table “${database}.${table}”.`);
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not delete table: ${errorMessage(error)}`);
		}
	}

	async function loadTableDefinition(table: string): Promise<void> {
		if (!connection || !currentDatabase) {
			return;
		}
		try {
			const definition = await readTableDefinition(connection, currentDatabase, table);
			void panel.webview.postMessage({ type: 'tableDefinition', table, definition });
		} catch (error) {
			void panel.webview.postMessage({ type: 'tableDefinitionError', message: errorMessage(error) });
		}
	}

	function previewCreateTable(definitionValue: unknown): void {
		if (!connection || !currentDatabase) {
			return;
		}
		try {
			const definition = parseCreateTableDefinition(definitionValue, tables);
			const sql = buildCreateTableSql(definition, currentDatabase, value => connection!.escape(value));
			pendingTableStatement = { id: crypto.randomUUID(), database: currentDatabase, sql };
			void panel.webview.postMessage({
				type: 'tableStatementPreview',
				confirmationId: pendingTableStatement.id,
				sql,
			});
		} catch (error) {
			pendingTableStatement = undefined;
			void panel.webview.postMessage({ type: 'tableCreateError', message: errorMessage(error) });
		}
	}

	async function previewAlterTable(table: string, definitionValue: unknown): Promise<void> {
		if (!connection || !currentDatabase) {
			return;
		}
		try {
			const original = await readTableDefinition(connection, currentDatabase, table);
			const definition = parseCreateTableDefinition(definitionValue, tables, table, new Set(original.columns.map(column => column.name)));
			const sql = buildAlterTableSql(original, definition, currentDatabase, value => connection!.escape(value));
			pendingTableStatement = { id: crypto.randomUUID(), database: currentDatabase, sql };
			void panel.webview.postMessage({
				type: 'tableStatementPreview',
				confirmationId: pendingTableStatement.id,
				sql,
			});
		} catch (error) {
			pendingTableStatement = undefined;
			void panel.webview.postMessage({ type: 'tableCreateError', message: errorMessage(error) });
		}
	}

	async function confirmTableStatement(confirmationId: string): Promise<void> {
		if (!connection || !pendingTableStatement
			|| pendingTableStatement.id !== confirmationId
			|| pendingTableStatement.database !== currentDatabase) {
			void panel.webview.postMessage({ type: 'tableCreateError', message: 'The SQL preview has expired. Review the form again.' });
			return;
		}
		const { sql } = pendingTableStatement;
		try {
			await connection.query(sql);
			pendingTableStatement = undefined;
			await loadTables();
			void panel.webview.postMessage({ type: 'tableStatementExecuted' });
		} catch (error) {
			void panel.webview.postMessage({ type: 'tableCreateError', message: errorMessage(error) });
		}
	}

	async function loadTables(): Promise<void> {
		if (!connection || !currentDatabase) {
			tables.clear();
			void panel.webview.postMessage({ type: 'tables', database: currentDatabase, tables: [] });
			return;
		}

		const database = currentDatabase;
		void panel.webview.postMessage({ type: 'tablesLoading', database });
		try {
			const [rows] = await connection.query<RowDataPacket[]>(
				`SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_ROWS AS rowCount,
					DATA_LENGTH AS dataSize, INDEX_LENGTH AS indexSize, UPDATE_TIME AS updatedAt,
					TABLE_COLLATION AS collation
				FROM information_schema.TABLES
				WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
				ORDER BY TABLE_NAME`,
				[database],
			);
			if (database !== currentDatabase) {
				return;
			}
			const tableInfo = rows.map(normalizeTableInfo);
			tables = new Set(tableInfo.map(table => table.name));
			void panel.webview.postMessage({
				type: 'tables',
				database,
				tables: tableInfo,
			});
		} catch (error) {
			void panel.webview.postMessage({ type: 'tablesError', message: errorMessage(error) });
		}
	}
}

export function configureMysqlTablePreview(
	extensionUri: vscode.Uri,
	panel: vscode.WebviewPanel,
	server: MysqlServer,
	credentials: ServerCredentials,
	database: string,
	table: string,
): void {
	panel.title = `${table} - ${database}`;
	panel.webview.options = {
		enableScripts: true,
		localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
	};
	panel.iconPath = new vscode.ThemeIcon('table');
	panel.webview.html = getWebviewHtml(panel.webview, extensionUri, 'mysqlTablePreview', `${table} - ${database}`);

	let connection: Connection | undefined;
	let disposed = false;
	let columns: string[] = [];
	let columnInfo: MysqlColumnInfo[] = [];
	let columnNames = new Set<string>();
	let editableColumnNames = new Set<string>();
	let primaryKeyColumns: string[] = [];
	let pageRows = new Map<string, RowDataPacket>();
	let currentRequest = { page: 1, pageSize: 100, sort: undefined as MysqlTableSort | undefined, filters: [] as MysqlTableFilter[] };
	let pendingRowUpdate: { id: string; query: string; parameters: unknown[] } | undefined;
	let pendingRowInsert: { id: string; query: string; parameters: unknown[] } | undefined;
	panel.onDidDispose(() => {
		disposed = true;
		void connection?.end();
	});
	panel.webview.onDidReceiveMessage(async (message: MysqlTablePreviewMessage) => {
		if (message.type === 'ready') {
			await panel.webview.postMessage({ type: 'initialize', database, table });
			await connectAndLoad();
			return;
		}
		if (message.type === 'previewUpdateRow') {
			previewUpdateRow(message.rowId, message.values);
			return;
		}
		if (message.type === 'confirmRowUpdate') {
			await confirmRowUpdate(message.confirmationId);
			return;
		}
		if (message.type === 'deleteRow') {
			await deleteRow(message.rowId);
			return;
		}
		if (message.type === 'previewInsertRow') {
			previewInsertRow(message.values);
			return;
		}
		if (message.type === 'confirmRowInsert') {
			await confirmRowInsert(message.confirmationId);
			return;
		}
		if (message.type === 'refresh') {
			await loadPage(currentRequest.page, currentRequest.pageSize, currentRequest.sort, currentRequest.filters);
			return;
		}
		if (
			message.type !== 'loadPage'
			|| typeof message.page !== 'number'
			|| !Number.isInteger(message.page)
			|| message.page < 1
			|| typeof message.pageSize !== 'number'
			|| !mysqlTablePageSizes.has(message.pageSize)
		) {
			return;
		}
		const sort = parseTableSort(message.sort, columnNames);
		const filters = parseTableFilters(message.filters, columnNames);
		await loadPage(message.page, message.pageSize, sort, filters);
	});
	async function connectAndLoad(): Promise<void> {
		if (connection) {
			return;
		}
		try {
			connection = await createMysqlConnection(server, credentials, database);
			if (disposed) {
				await connection.end();
				return;
			}
			const [, fields] = await connection.query<RowDataPacket[]>('SELECT * FROM ??.?? LIMIT 0', [database, table]);
			columns = fields.map((field: FieldPacket) => field.name);
			columnNames = new Set(columns);
			const [metadataRows] = await connection.query<RowDataPacket[]>(
				`SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
					COLUMN_KEY AS columnKey, COLUMN_DEFAULT AS columnDefault, EXTRA AS extra,
					GENERATION_EXPRESSION AS generationExpression
				FROM information_schema.COLUMNS
				WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
				ORDER BY ORDINAL_POSITION`,
				[database, table],
			);
			columnInfo = metadataRows.map(row => {
				const extra = String(row.extra ?? '').toLowerCase();
				const generationExpression = String(row.generationExpression ?? '');
				return {
					name: String(row.name),
					dataType: String(row.dataType),
					boolean: String(row.dataType).toLowerCase() === 'bit' && String(row.columnType).toLowerCase() === 'bit(1)',
					nullable: row.isNullable === 'YES',
					primaryKey: row.columnKey === 'PRI',
					autoIncrement: extra.includes('auto_increment'),
					hasDefault: row.columnDefault !== null || extra.includes('default_generated'),
					editable: !generationExpression,
				};
			});
			editableColumnNames = new Set(columnInfo.filter(column => column.editable).map(column => column.name));
			primaryKeyColumns = columnInfo.filter(column => column.primaryKey).map(column => column.name);
			await loadPage(1, 100, undefined, []);
		} catch (error) {
			void panel.webview.postMessage({ type: 'tableError', message: errorMessage(error) });
		}
	}

	async function loadPage(page: number, pageSize: number, sort: MysqlTableSort | undefined, filters: MysqlTableFilter[]): Promise<void> {
		if (!connection) {
			return;
		}
		pendingRowUpdate = undefined;
		pendingRowInsert = undefined;
		currentRequest = { page, pageSize, sort, filters };
		void panel.webview.postMessage({ type: 'tableLoading' });
		try {
			const { clause: whereClause, parameters: filterParameters } = buildTableFilterClause(filters);
			const [countRows] = await connection.query<RowDataPacket[]>(
				`SELECT COUNT(*) AS total FROM ??.??${whereClause}`,
				[database, table, ...filterParameters],
			);
			const totalRows = Number(countRows[0]?.total) || 0;
			const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
			const currentPage = Math.min(page, totalPages);
			const offset = (currentPage - 1) * pageSize;
			const orderClause = sort ? ` ORDER BY ?? ${sort.direction === 'asc' ? 'ASC' : 'DESC'}` : '';
			const [rows] = await connection.query<RowDataPacket[]>(
				`SELECT * FROM ??.??${whereClause}${orderClause} LIMIT ? OFFSET ?`,
				[database, table, ...filterParameters, ...(sort ? [sort.column] : []), pageSize, offset],
			);
			pageRows = new Map();
			const columnMetadata = new Map(columnInfo.map(column => [column.name, column]));
			const tableRows = rows.map(row => {
				const rowId = crypto.randomUUID();
				pageRows.set(rowId, row);
				return {
					rowId,
					values: columns.map(column => displayMysqlValue(row[column], columnMetadata.get(column)?.boolean)),
					editValues: columns.map(column => displayMysqlValue(row[column], columnMetadata.get(column)?.boolean)),
				};
			});
			void panel.webview.postMessage({
				type: 'tableData',
				columns,
				columnInfo,
				rows: tableRows,
				canEdit: primaryKeyColumns.length > 0,
				editDisabledReason: primaryKeyColumns.length > 0 ? undefined : 'Rows cannot be edited because this table has no primary key.',
				page: currentPage,
				pageSize,
				totalRows,
				totalPages,
				sort,
				filters,
			});
		} catch (error) {
			void panel.webview.postMessage({ type: 'tableError', message: errorMessage(error) });
		}
	}

	function previewUpdateRow(rowIdValue: unknown, valuesValue: unknown): void {
		if (!connection || typeof rowIdValue !== 'string' || primaryKeyColumns.length === 0) {
			return;
		}
		const originalRow = pageRows.get(rowIdValue);
		const changes = parseRowChanges(valuesValue, editableColumnNames, columnInfo);
		if (!originalRow || changes.length === 0) {
			return;
		}
		try {
			const setClause = changes.map(() => '?? = ?').join(', ');
			const whereClause = primaryKeyColumns.map(() => '?? <=> ?').join(' AND ');
			const query = `UPDATE ??.?? SET ${setClause} WHERE ${whereClause} LIMIT 1`;
			const parameters = [
				database,
				table,
				...changes.flatMap(change => [change.column, change.value]),
				...primaryKeyColumns.flatMap(column => [column, originalRow[column]]),
			];
			pendingRowUpdate = { id: crypto.randomUUID(), query, parameters };
			void panel.webview.postMessage({
				type: 'rowUpdatePreview',
				confirmationId: pendingRowUpdate.id,
				sql: `${connection.format(query, parameters)};`,
			});
		} catch (error) {
			pendingRowUpdate = undefined;
			void panel.webview.postMessage({ type: 'rowUpdateError', message: errorMessage(error) });
		}
	}

	async function confirmRowUpdate(confirmationIdValue: unknown): Promise<void> {
		if (!connection || typeof confirmationIdValue !== 'string'
			|| !pendingRowUpdate || pendingRowUpdate.id !== confirmationIdValue) {
			void panel.webview.postMessage({ type: 'rowUpdateError', message: 'The SQL preview has expired. Review the changes again.' });
			return;
		}
		const { query, parameters } = pendingRowUpdate;
		try {
			const [result] = await connection.query<ResultSetHeader>(query, parameters);
			if (result.affectedRows !== 1) {
				throw new Error('The row was not updated. It may have been changed or deleted.');
			}
			pendingRowUpdate = undefined;
			void panel.webview.postMessage({ type: 'rowUpdated' });
			await loadPage(currentRequest.page, currentRequest.pageSize, currentRequest.sort, currentRequest.filters);
		} catch (error) {
			void panel.webview.postMessage({ type: 'rowUpdateError', message: errorMessage(error) });
		}
	}

	async function deleteRow(rowIdValue: unknown): Promise<void> {
		if (!connection || typeof rowIdValue !== 'string' || primaryKeyColumns.length === 0) {
			return;
		}
		const originalRow = pageRows.get(rowIdValue);
		if (!originalRow) {
			return;
		}
		const confirmation = await vscode.window.showWarningMessage(
			`Delete this row from “${database}.${table}”?`,
			{ modal: true },
			'Delete',
		);
		if (confirmation !== 'Delete') {
			return;
		}
		try {
			const whereClause = primaryKeyColumns.map(() => '?? <=> ?').join(' AND ');
			const parameters = [
				database,
				table,
				...primaryKeyColumns.flatMap(column => [column, originalRow[column]]),
			];
			const [result] = await connection.query<ResultSetHeader>(
				`DELETE FROM ??.?? WHERE ${whereClause} LIMIT 1`,
				parameters,
			);
			if (result.affectedRows !== 1) {
				throw new Error('The row was not deleted. It may have already been changed or deleted.');
			}
			await loadPage(currentRequest.page, currentRequest.pageSize, currentRequest.sort, currentRequest.filters);
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not delete row: ${errorMessage(error)}`);
		}
	}

	function previewInsertRow(valuesValue: unknown): void {
		if (!connection || !valuesValue || typeof valuesValue !== 'object' || Array.isArray(valuesValue)) {
			return;
		}
		const insertableColumnNames = new Set(columnInfo
			.filter(column => column.editable && !column.autoIncrement)
			.map(column => column.name));
		const values = parseRowChanges(valuesValue, insertableColumnNames, columnInfo);
		try {
			let query: string;
			let parameters: unknown[];
			if (values.length === 0) {
				query = 'INSERT INTO ??.?? () VALUES ()';
				parameters = [database, table];
			} else {
				const columnsClause = values.map(() => '??').join(', ');
				const valuesClause = values.map(() => '?').join(', ');
				query = `INSERT INTO ??.?? (${columnsClause}) VALUES (${valuesClause})`;
				parameters = [database, table, ...values.map(value => value.column), ...values.map(value => value.value)];
			}
			pendingRowInsert = { id: crypto.randomUUID(), query, parameters };
			void panel.webview.postMessage({
				type: 'rowInsertPreview',
				confirmationId: pendingRowInsert.id,
				sql: `${connection.format(query, parameters)};`,
			});
		} catch (error) {
			pendingRowInsert = undefined;
			void panel.webview.postMessage({ type: 'rowInsertError', message: errorMessage(error) });
		}
	}

	async function confirmRowInsert(confirmationIdValue: unknown): Promise<void> {
		if (!connection || typeof confirmationIdValue !== 'string'
			|| !pendingRowInsert || pendingRowInsert.id !== confirmationIdValue) {
			void panel.webview.postMessage({ type: 'rowInsertError', message: 'The SQL preview has expired. Review the values again.' });
			return;
		}
		const { query, parameters } = pendingRowInsert;
		try {
			await connection.query(query, parameters);
			pendingRowInsert = undefined;
			void panel.webview.postMessage({ type: 'rowInserted' });
			await loadPage(currentRequest.page, currentRequest.pageSize, currentRequest.sort, currentRequest.filters);
		} catch (error) {
			void panel.webview.postMessage({ type: 'rowInsertError', message: errorMessage(error) });
		}
	}
}

interface MysqlCreateTableColumn {
	name: string;
	originalName?: string;
	type: string;
	length: string;
	nullable: boolean;
	primaryKey: boolean;
	autoIncrement: boolean;
	defaultKind: 'none' | 'null' | 'currentTimestamp' | 'value';
	defaultValue: string;
}


function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
interface MysqlCreateTableDefinition {
	name: string;
	columns: MysqlCreateTableColumn[];
}

const createTableColumnTypes = new Set([
	'BIGINT', 'INT', 'SMALLINT', 'TINYINT', 'BIT', 'DECIMAL', 'VARCHAR', 'CHAR', 'TEXT', 'LONGTEXT',
	'BOOLEAN', 'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'JSON', 'BLOB',
]);
const integerColumnTypes = new Set(['BIGINT', 'INT', 'SMALLINT', 'TINYINT']);
const lengthColumnTypes = new Set(['BIT', 'DECIMAL', 'VARCHAR', 'CHAR']);
const currentTimestampColumnTypes = new Set(['DATETIME', 'TIMESTAMP']);

function parseCreateTableDefinition(
	value: unknown,
	existingTables: Set<string>,
	originalTableName?: string,
	originalColumnNames = new Set<string>(),
): MysqlCreateTableDefinition {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Invalid table definition.');
	}
	const definition = value as Record<string, unknown>;
	const name = parseMysqlIdentifier(definition.name, 'Table name');
	if (existingTables.has(name) && name !== originalTableName) {
		throw new Error(`A table named “${name}” already exists.`);
	}
	if (!Array.isArray(definition.columns) || definition.columns.length === 0) {
		throw new Error('Add at least one column.');
	}
	const columnNames = new Set<string>();
	const mappedOriginalColumnNames = new Set<string>();
	let autoIncrementColumns = 0;
	const columns = definition.columns.map((value, index) => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error(`Column ${index + 1} is invalid.`);
		}
		const input = value as Record<string, unknown>;
		const columnName = parseMysqlIdentifier(input.name, `Column ${index + 1} name`);
		const submittedOriginalName = typeof input.originalName === 'string' ? input.originalName : undefined;
		if (submittedOriginalName && !originalColumnNames.has(submittedOriginalName)) {
			throw new Error(`Column “${submittedOriginalName}” has changed or no longer exists. Reload the table definition.`);
		}
		const originalName = submittedOriginalName;
		if (originalName && mappedOriginalColumnNames.has(originalName)) {
			throw new Error(`Original column “${originalName}” is mapped more than once.`);
		}
		if (originalName) {
			mappedOriginalColumnNames.add(originalName);
		}
		if (columnNames.has(columnName)) {
			throw new Error(`Column name “${columnName}” is duplicated.`);
		}
		columnNames.add(columnName);
		const type = typeof input.type === 'string' ? input.type.toUpperCase() : '';
		if (!createTableColumnTypes.has(type)) {
			throw new Error(`Column “${columnName}” has an unsupported type.`);
		}
		const length = typeof input.length === 'string' ? input.length.trim() : '';
		if (length && (!lengthColumnTypes.has(type) || !/^\d+(?:,\d+)?$/.test(length))) {
			throw new Error(`Column “${columnName}” has an invalid length.`);
		}
		if (type === 'BIT' && length && (!/^\d+$/.test(length) || Number(length) < 1 || Number(length) > 64)) {
			throw new Error(`Column “${columnName}” must have a bit length from 1 to 64.`);
		}
		if ((type === 'VARCHAR' || type === 'CHAR') && !length) {
			throw new Error(`Column “${columnName}” requires a length.`);
		}
		const primaryKey = input.primaryKey === true;
		const autoIncrement = input.autoIncrement === true;
		if (autoIncrement && (!integerColumnTypes.has(type) || !primaryKey)) {
			throw new Error(`Auto increment column “${columnName}” must be an integer primary key.`);
		}
		if (autoIncrement && ++autoIncrementColumns > 1) {
			throw new Error('Only one column can use auto increment.');
		}
		const defaultKind = input.defaultKind;
		if (defaultKind !== 'none' && defaultKind !== 'null' && defaultKind !== 'currentTimestamp' && defaultKind !== 'value') {
			throw new Error(`Column “${columnName}” has an invalid default value.`);
		}
		const validatedDefaultKind: MysqlCreateTableColumn['defaultKind'] = defaultKind;
		const nullable = input.nullable === true && !primaryKey;
		if (validatedDefaultKind === 'null' && !nullable) {
			throw new Error(`Column “${columnName}” must be nullable to default to NULL.`);
		}
		if (validatedDefaultKind === 'currentTimestamp' && !currentTimestampColumnTypes.has(type)) {
			throw new Error(`Column “${columnName}” cannot default to CURRENT_TIMESTAMP.`);
		}
		return {
			name: columnName,
			originalName,
			type,
			length,
			nullable,
			primaryKey,
			autoIncrement,
			defaultKind: validatedDefaultKind,
			defaultValue: typeof input.defaultValue === 'string' ? input.defaultValue : '',
		};
	});
	return { name, columns };
}

function parseMysqlIdentifier(value: unknown, label: string): string {
	const identifier = typeof value === 'string' ? value.trim() : '';
	if (!identifier) {
		throw new Error(`${label} is required.`);
	}
	if (Buffer.byteLength(identifier, 'utf8') > 64) {
		throw new Error(`${label} must be 64 bytes or fewer.`);
	}
	return identifier;
}

function escapeMysqlIdentifier(identifier: string): string {
	return `\`${identifier.replaceAll('`', '``')}\``;
}

async function readTableDefinition(
	connection: Connection,
	database: string,
	table: string,
): Promise<MysqlCreateTableDefinition> {
	const [rows] = await connection.query<RowDataPacket[]>(
		`SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, IS_NULLABLE AS isNullable,
			COLUMN_KEY AS columnKey, COLUMN_DEFAULT AS columnDefault, EXTRA AS extra,
			CHARACTER_MAXIMUM_LENGTH AS characterLength, NUMERIC_PRECISION AS numericPrecision,
			NUMERIC_SCALE AS numericScale
		FROM information_schema.COLUMNS
		WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
		ORDER BY ORDINAL_POSITION`,
		[database, table],
	);
	if (rows.length === 0) {
		throw new Error(`Table “${table}” no longer exists.`);
	}
	const columns = rows.map(row => {
		const type = String(row.dataType).toUpperCase();
		if (!createTableColumnTypes.has(type)) {
			throw new Error(`Column “${String(row.name)}” uses unsupported type ${type}.`);
		}
		let length = '';
		if ((type === 'VARCHAR' || type === 'CHAR') && row.characterLength !== null) {
			length = String(row.characterLength);
		} else if (type === 'BIT' && row.numericPrecision !== null) {
			length = String(row.numericPrecision);
		} else if (type === 'DECIMAL' && row.numericPrecision !== null) {
			length = `${String(row.numericPrecision)},${String(row.numericScale ?? 0)}`;
		}
		const defaultValue = row.columnDefault === null ? '' : String(row.columnDefault);
		const nullable = row.isNullable === 'YES';
		const defaultKind: MysqlCreateTableColumn['defaultKind'] = row.columnDefault === null
			? nullable ? 'null' : 'none'
			: currentTimestampColumnTypes.has(type) && /^current_timestamp(?:\(\d+\))?$/i.test(defaultValue)
				? 'currentTimestamp'
				: 'value';
		return {
			name: String(row.name),
			originalName: String(row.name),
			type,
			length,
			nullable,
			primaryKey: row.columnKey === 'PRI',
			autoIncrement: String(row.extra ?? '').toLowerCase().includes('auto_increment'),
			defaultKind,
			defaultValue: defaultKind === 'value' ? defaultValue : '',
		};
	});
	return { name: table, columns };
}

function buildColumnDefinition(column: MysqlCreateTableColumn, escapeValue: (value: string) => string): string {
	const length = column.length ? `(${column.length})` : '';
	const nullable = column.nullable && !column.primaryKey ? ' NULL' : ' NOT NULL';
	let defaultClause = '';
	if (column.defaultKind === 'null') {
		defaultClause = ' DEFAULT NULL';
	} else if (column.defaultKind === 'currentTimestamp') {
		defaultClause = ' DEFAULT CURRENT_TIMESTAMP';
	} else if (column.defaultKind === 'value') {
		defaultClause = ` DEFAULT ${escapeValue(column.defaultValue)}`;
	}
	return `${escapeMysqlIdentifier(column.name)} ${column.type}${length}${nullable}${defaultClause}${column.autoIncrement ? ' AUTO_INCREMENT' : ''}`;
}

function buildCreateTableSql(
	definition: MysqlCreateTableDefinition,
	database: string,
	escapeValue: (value: string) => string,
): string {
	const columnSql = definition.columns.map(column => {
		return `  ${buildColumnDefinition(column, escapeValue)}`;
	});
	const primaryKeys = definition.columns.filter(column => column.primaryKey);
	if (primaryKeys.length > 0) {
		columnSql.push(`  PRIMARY KEY (${primaryKeys.map(column => escapeMysqlIdentifier(column.name)).join(', ')})`);
	}
	return `CREATE TABLE ${escapeMysqlIdentifier(database)}.${escapeMysqlIdentifier(definition.name)} (\n${columnSql.join(',\n')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
}

function buildAlterTableSql(
	original: MysqlCreateTableDefinition,
	definition: MysqlCreateTableDefinition,
	database: string,
	escapeValue: (value: string) => string,
): string {
	const clauses: string[] = [];
	const originalColumns = new Map(original.columns.map(column => [column.name, column]));
	const desiredOriginalNames = new Set(definition.columns.flatMap(column => column.originalName ? [column.originalName] : []));
	for (const column of original.columns) {
		if (!desiredOriginalNames.has(column.name)) {
			clauses.push(`  DROP COLUMN ${escapeMysqlIdentifier(column.name)}`);
		}
	}
	for (const column of definition.columns) {
		if (column.originalName) {
			const originalColumn = originalColumns.get(column.originalName);
			if (!originalColumn || !sameColumnDefinition(originalColumn, column)) {
				clauses.push(`  CHANGE COLUMN ${escapeMysqlIdentifier(column.originalName)} ${buildColumnDefinition(column, escapeValue)}`);
			}
		} else {
			clauses.push(`  ADD COLUMN ${buildColumnDefinition(column, escapeValue)}`);
		}
	}
	const originalPrimaryKeys = original.columns.filter(column => column.primaryKey).map(column => column.name);
	const primaryKeyColumns = definition.columns.filter(column => column.primaryKey);
	const desiredOriginalPrimaryKeys = primaryKeyColumns.map(column => column.originalName ?? column.name);
	if (!sameStringArray(originalPrimaryKeys, desiredOriginalPrimaryKeys)) {
		if (originalPrimaryKeys.length > 0) {
			clauses.push('  DROP PRIMARY KEY');
		}
		if (primaryKeyColumns.length > 0) {
			clauses.push(`  ADD PRIMARY KEY (${primaryKeyColumns.map(column => escapeMysqlIdentifier(column.name)).join(', ')})`);
		}
	}
	if (definition.name !== original.name) {
		clauses.push(`  RENAME TO ${escapeMysqlIdentifier(database)}.${escapeMysqlIdentifier(definition.name)}`);
	}
	if (clauses.length === 0) {
		throw new Error('No table changes to apply.');
	}
	return `ALTER TABLE ${escapeMysqlIdentifier(database)}.${escapeMysqlIdentifier(original.name)}\n${clauses.join(',\n')};`;
}

function sameColumnDefinition(original: MysqlCreateTableColumn, column: MysqlCreateTableColumn): boolean {
	return original.name === column.name
		&& original.type === column.type
		&& original.length === column.length
		&& original.nullable === column.nullable
		&& original.autoIncrement === column.autoIncrement
		&& original.defaultKind === column.defaultKind
		&& original.defaultValue === column.defaultValue;
}

function sameStringArray(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
