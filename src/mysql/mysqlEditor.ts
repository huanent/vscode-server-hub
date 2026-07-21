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
import { codiconsDistUri, createNonce, escapeHtml } from '../webview/webviewUtils';
import { exportMysqlDatabase, importMysqlDatabase } from './mysqlDatabaseTransfer';

export function configureMysqlEditor(
	extensionUri: vscode.Uri,
	panel: vscode.WebviewPanel,
	server: MysqlServer,
	password: string,
	openTable: (database: string, table: string) => void,
	openSql: (database: string, initialSql?: string) => void,
): void {
	panel.title = server.name;
	panel.webview.options = {
		enableScripts: true,
		localResourceRoots: [codiconsDistUri(extensionUri)],
	};
	panel.iconPath = new vscode.ThemeIcon('database');
	panel.webview.html = renderMysqlOverview(panel.webview, extensionUri, server);

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

	void connectAndLoad();

	async function connectAndLoad(): Promise<void> {
		try {
			connection = await createMysqlConnection(server, password);
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
			await exportMysqlDatabase(server, password, database);
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not export database: ${errorMessage(error)}`);
		}
	}

	async function importDatabase(): Promise<void> {
		const database = currentDatabase;
		try {
			const completed = await importMysqlDatabase(server, password, database);
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
	password: string,
	database: string,
	table: string,
): void {
	panel.title = `${table} - ${database}`;
	panel.webview.options = {
		enableScripts: true,
		localResourceRoots: [codiconsDistUri(extensionUri)],
	};
	panel.iconPath = new vscode.ThemeIcon('table');
	panel.webview.html = renderTablePreview(panel.webview, extensionUri, database, table);

	let connection: Connection | undefined;
	let disposed = false;
	let columns: string[] = [];
	let columnInfo: MysqlColumnInfo[] = [];
	let columnNames = new Set<string>();
	let editableColumnNames = new Set<string>();
	let primaryKeyColumns: string[] = [];
	let pageRows = new Map<string, RowDataPacket>();
	let currentRequest = { page: 1, pageSize: 100, sort: undefined as MysqlTableSort | undefined, filters: [] as MysqlTableFilter[] };
	panel.onDidDispose(() => {
		disposed = true;
		void connection?.end();
	});
	panel.webview.onDidReceiveMessage(async (message: MysqlTablePreviewMessage) => {
		if (message.type === 'updateRow') {
			await updateRow(message.rowId, message.values);
			return;
		}
		if (message.type === 'insertRow') {
			await insertRow(message.values);
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
	void connectAndLoad();

	async function connectAndLoad(): Promise<void> {
		try {
			connection = await createMysqlConnection(server, password, database);
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

	async function updateRow(rowIdValue: unknown, valuesValue: unknown): Promise<void> {
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
			const parameters = [
				database,
				table,
				...changes.flatMap(change => [change.column, change.value]),
				...primaryKeyColumns.flatMap(column => [column, originalRow[column]]),
			];
			const [result] = await connection.query<ResultSetHeader>(
				`UPDATE ??.?? SET ${setClause} WHERE ${whereClause} LIMIT 1`,
				parameters,
			);
			if (result.affectedRows !== 1) {
				throw new Error('The row was not updated. It may have been changed or deleted.');
			}
			void panel.webview.postMessage({ type: 'rowUpdated' });
			await loadPage(currentRequest.page, currentRequest.pageSize, currentRequest.sort, currentRequest.filters);
		} catch (error) {
			void panel.webview.postMessage({ type: 'rowUpdateError', message: errorMessage(error) });
		}
	}

	async function insertRow(valuesValue: unknown): Promise<void> {
		if (!connection || !valuesValue || typeof valuesValue !== 'object' || Array.isArray(valuesValue)) {
			return;
		}
		const insertableColumnNames = new Set(columnInfo
			.filter(column => column.editable && !column.autoIncrement)
			.map(column => column.name));
		const values = parseRowChanges(valuesValue, insertableColumnNames, columnInfo);
		try {
			if (values.length === 0) {
				await connection.query('INSERT INTO ??.?? () VALUES ()', [database, table]);
			} else {
				const columnsClause = values.map(() => '??').join(', ');
				const valuesClause = values.map(() => '?').join(', ');
				await connection.query(
					`INSERT INTO ??.?? (${columnsClause}) VALUES (${valuesClause})`,
					[database, table, ...values.map(value => value.column), ...values.map(value => value.value)],
				);
			}
			void panel.webview.postMessage({ type: 'rowInserted' });
			await loadPage(currentRequest.page, currentRequest.pageSize, currentRequest.sort, currentRequest.filters);
		} catch (error) {
			void panel.webview.postMessage({ type: 'rowInsertError', message: errorMessage(error) });
		}
	}
}

function renderMysqlOverview(webview: vscode.Webview, extensionUri: vscode.Uri, server: MysqlServer): string {
	const nonce = createNonce();
	const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(codiconsDistUri(extensionUri), 'codicon.css'));
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<link rel="stylesheet" href="${codiconsUri}">
	<title>${escapeHtml(server.name)}</title>
	<style>
		:root { color-scheme: light dark; }
		* { box-sizing: border-box; }
		html, body { width: 100%; min-width: 300px; height: 100%; margin: 0; overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
		body { display: grid; grid-template-rows: 42px minmax(0, 1fr); padding: 4px; user-select: none; }
		button, input, select { font: inherit; }
		.toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; grid-template-areas: "database primary view"; align-items: center; gap: 10px; padding: 0 8px; border-bottom: 1px solid var(--vscode-panel-border); }
		.primary-actions, .view-actions { display: flex; align-items: center; gap: 2px; }
		.primary-actions { grid-area: primary; }
		.view-actions { padding: 2px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; background: var(--vscode-input-background); }
		.icon-button { display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 4px; color: var(--vscode-icon-foreground); background: transparent; cursor: pointer; }
		.icon-button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
		.icon-button.selected { background: var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground)); }
		.icon-button:disabled { opacity: 0.4; cursor: default; }
		.icon-button .codicon { font-size: 16px; }
		.icon-button:focus-visible, .database-select:focus-visible, .table-entry:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
		.database-path { display: flex; grid-area: database; min-width: 0; align-items: center; gap: 8px; }
		.connection-name { min-width: 0; overflow: hidden; font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
		.workspace { display: grid; min-width: 0; min-height: 0; grid-template-columns: 220px minmax(0, 1fr); }
		.database-sidebar { display: grid; min-width: 0; min-height: 0; grid-template-rows: 31px minmax(0, 1fr); border-right: 1px solid var(--vscode-panel-border); }
		.database-header { display: flex; padding: 0 4px 0 10px; align-items: center; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 600; text-transform: uppercase; }
		.database-header-actions { display: flex; margin-left: auto; align-items: center; gap: 1px; }
		.database-header .icon-button { width: 24px; height: 24px; }
		.database-list { padding: 4px; overflow: auto; }
		.database-entry { position: relative; display: grid; width: 100%; height: 28px; grid-template-columns: minmax(0, 1fr) 24px 24px; align-items: center; overflow: hidden; border-radius: 3px; color: var(--vscode-foreground); }
		.database-entry:hover { color: var(--vscode-list-hoverForeground); background: var(--vscode-list-hoverBackground); }
		.database-entry.selected { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
		.database-select { display: grid; min-width: 0; height: 100%; padding: 0 4px 0 7px; grid-template-columns: 18px minmax(0, 1fr); align-items: center; gap: 5px; border: 0; color: inherit; background: transparent; text-align: left; cursor: pointer; }
		.database-select .codicon { color: var(--vscode-symbolIcon-namespaceForeground, currentColor); font-size: 14px; }
		.database-select span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.database-item-action { visibility: hidden; width: 22px; height: 22px; color: inherit; }
		.database-delete { margin-right: 2px; }
		.database-entry:hover .database-item-action, .database-entry:focus-within .database-item-action { visibility: visible; }
		.database-entry.selected .database-item-action:hover { background: rgba(255, 255, 255, 0.16); }
		main { min-width: 0; min-height: 0; overflow: auto; }
		.column-header, .table-list.list-view .table-entry { display: grid; grid-template-columns: minmax(190px, 1fr) 110px minmax(160px, 210px) 130px 60px; align-items: center; }
		.column-header { position: sticky; top: 0; z-index: 2; height: 30px; padding: 0 14px 0 18px; border-bottom: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); font-size: 12px; }
		.column-header[hidden] { display: none; }
		.column-header span:not(:first-child) { text-align: right; }
		.column-header span:nth-child(2), .column-header span:nth-child(3) { padding-left: 12px; text-align: left; }
		.table-list.list-view { padding: 4px 8px 12px; }
		.table-list.list-view .table-entry { min-height: 32px; padding: 0 6px 0 10px; border-radius: 3px; }
		.table-entry { position: relative; color: var(--vscode-foreground); cursor: default; }
		.table-entry:hover { color: var(--vscode-list-hoverForeground); background: var(--vscode-list-hoverBackground); }
		.table-entry.selected { color: var(--vscode-list-inactiveSelectionForeground, var(--vscode-foreground)); background: var(--vscode-list-inactiveSelectionBackground); }
		.entry-name { display: flex; min-width: 0; align-items: center; gap: 8px; }
		.table-icon { display: inline-grid; flex: 0 0 auto; width: 17px; height: 17px; place-items: center; color: var(--vscode-symbolIcon-structForeground, var(--vscode-icon-foreground)); font-size: 15px; }
		.entry-name span:last-child, .entry-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.entry-meta { padding-left: 12px; color: var(--vscode-descriptionForeground); font-size: 12px; text-align: right; }
		.selected .entry-meta { color: inherit; }
		.table-actions { display: flex; justify-self: end; align-items: center; gap: 2px; }
		.table-actions .icon-button { width: 26px; height: 26px; color: inherit; }
		.table-list.grid-view { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); grid-auto-rows: 154px; gap: 10px; padding: 14px 8px; }
		.table-list.grid-view .table-entry { display: grid; grid-template-rows: 24px minmax(0, 1fr); gap: 12px; min-width: 0; height: 100%; padding: 14px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
		.table-list.grid-view .table-entry:hover { border-color: var(--vscode-focusBorder); }
		.table-list.grid-view .entry-name { padding-right: 58px; align-items: center; font-weight: 600; }
		.table-list.grid-view .table-actions { position: absolute; top: 10px; right: 10px; }
		.table-list.grid-view .table-icon { font-size: 22px; }
		.grid-details { display: grid; gap: 7px 12px; }
		.grid-detail { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); min-width: 0; gap: 12px; }
		.grid-label { display: block; color: var(--vscode-descriptionForeground); font-size: 11px; }
		.grid-value { display: block; overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
		.table-list.grid-view .grid-details { align-content: start; }
		.table-list.grid-view .entry-meta { padding-left: 0; text-align: right; }
		.table-list.list-view .grid-details { display: contents; }
		.table-list.list-view .grid-detail { display: contents; }
		.table-list.list-view .grid-label { display: none; }
		.table-list.list-view .grid-detail:nth-child(1) .entry-meta, .table-list.list-view .grid-detail:nth-child(2) .entry-meta { text-align: left; }
		.status { padding: 44px 0; color: var(--vscode-descriptionForeground); text-align: center; }
		.error { color: var(--vscode-errorForeground); }
		dialog { width: min(920px, calc(100vw - 32px)); max-height: min(760px, calc(100vh - 32px)); padding: 0; overflow: hidden; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 6px; color: var(--vscode-foreground); background: var(--vscode-editor-background); box-shadow: 0 12px 38px rgba(0, 0, 0, 0.35); }
		dialog::backdrop { background: rgba(0, 0, 0, 0.45); }
		.create-table-form { display: grid; max-height: inherit; grid-template-rows: auto minmax(0, 1fr) auto; }
		.dialog-header, .dialog-footer { display: flex; min-height: 48px; padding: 8px 14px; align-items: center; gap: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
		.dialog-header h2 { margin: 0; font-size: 14px; font-weight: 600; }
		.dialog-header .icon-button { margin-left: auto; }
		.dialog-content { display: grid; gap: 14px; padding: 14px; overflow: auto; }
		.form-field { display: grid; gap: 5px; }
		.form-label { color: var(--vscode-descriptionForeground); font-size: 12px; }
		.form-input, .form-select { width: 100%; min-width: 0; height: 28px; padding: 3px 7px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); }
		.form-input:focus-visible, .form-select:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
		.columns-header { display: flex; align-items: center; }
		.columns-header strong { font-size: 12px; }
		.columns-header .icon-button { margin-left: auto; }
		.column-list { display: grid; gap: 6px; }
		.column-row { display: grid; grid-template-columns: minmax(120px, 1.4fr) minmax(110px, 1fr) minmax(74px, .7fr) auto auto auto minmax(130px, 1fr) 28px; gap: 6px; align-items: center; }
		.column-option { display: inline-flex; align-items: center; gap: 4px; color: var(--vscode-descriptionForeground); font-size: 11px; white-space: nowrap; }
		.default-field { display: grid; grid-template-columns: minmax(86px, .8fr) minmax(0, 1fr); gap: 4px; }
		.sql-preview { display: grid; gap: 7px; }
		.sql-preview[hidden] { display: none; }
		.sql-preview pre { min-height: 180px; max-height: 420px; margin: 0; padding: 12px; overflow: auto; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; color: var(--vscode-editor-foreground); background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.5; user-select: text; white-space: pre-wrap; }
		.dialog-error { min-height: 18px; margin: 0 auto 0 0; color: var(--vscode-errorForeground); font-size: 12px; }
		.dialog-footer { justify-content: flex-end; border-top: 1px solid var(--vscode-panel-border); border-bottom: 0; }
		.button { min-width: 72px; height: 28px; padding: 3px 12px; border: 1px solid transparent; border-radius: 2px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
		.button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
		.button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
		.button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
		.button:disabled { opacity: 0.5; cursor: default; }
		@media (max-width: 760px) { .workspace { grid-template-columns: 170px minmax(0, 1fr); } .column-header, .table-list.list-view .table-entry { grid-template-columns: minmax(180px, 1fr) 90px 110px 60px; } .column-header span:nth-child(3), .table-list.list-view .grid-detail:nth-child(2) { display: none; } }
		@media (max-width: 820px) { .column-row { grid-template-columns: minmax(120px, 1fr) minmax(100px, .8fr) 74px 28px; padding: 8px; border: 1px solid var(--vscode-panel-border); } .column-option, .default-field { grid-column: span 2; } }
		@media (max-width: 520px) { .table-list.grid-view { grid-template-columns: minmax(0, 1fr); } }
	</style>
</head>
<body>
	<header class="toolbar">
		<div class="database-path">
			<span class="connection-name" title="${escapeHtml(`${server.username}@${server.host}:${server.port}`)}">${escapeHtml(server.name)}</span>
			<button id="refreshButton" class="icon-button" type="button" title="Refresh tables" aria-label="Refresh tables"><i class="codicon codicon-refresh"></i></button>
		</div>
		<div class="primary-actions" role="toolbar" aria-label="Database actions">
			<button id="createTableButton" class="icon-button" type="button" title="Create table" aria-label="Create table" disabled><i class="codicon codicon-add"></i></button>
			<button id="sqlButton" class="icon-button" type="button" title="Open SQL editor" aria-label="Open SQL editor" disabled><i class="codicon codicon-edit-code"></i></button>
		</div>
		<div class="view-actions" role="group" aria-label="View">
			<button id="listViewButton" class="icon-button selected" type="button" title="List view" aria-label="List view" aria-pressed="true"><i class="codicon codicon-list-unordered"></i></button>
			<button id="gridViewButton" class="icon-button" type="button" title="Grid view" aria-label="Grid view" aria-pressed="false"><i class="codicon codicon-layout"></i></button>
		</div>
	</header>
	<div class="workspace">
		<aside class="database-sidebar">
			<div class="database-header">
				<span>Databases</span>
				<div class="database-header-actions" role="toolbar" aria-label="Database list actions">
					<button id="importDatabaseButton" class="icon-button" type="button" title="Import SQL into database" aria-label="Import SQL into database" disabled><i class="codicon codicon-cloud-download"></i></button>
					<button id="createDatabaseButton" class="icon-button" type="button" title="Create database" aria-label="Create database"><i class="codicon codicon-add"></i></button>
				</div>
			</div>
			<div id="databaseList" class="database-list" role="listbox" aria-label="Databases"></div>
		</aside>
		<main>
			<div id="columnHeader" class="column-header"><span>Name</span><span>Rows</span><span>Updated</span><span>Data size</span><span></span></div>
			<div id="tableList" class="table-list list-view" role="listbox" aria-label="Tables"></div>
			<div id="status" class="status" role="status" aria-live="polite">Connecting...</div>
		</main>
	</div>
	<dialog id="createTableDialog" aria-labelledby="createTableTitle">
		<form id="createTableForm" class="create-table-form">
			<div class="dialog-header">
				<h2 id="createTableTitle">Create table</h2>
				<button id="closeCreateTable" class="icon-button" type="button" title="Close" aria-label="Close"><i class="codicon codicon-close"></i></button>
			</div>
			<div class="dialog-content">
				<div id="tableDefinitionFields">
					<label class="form-field">
						<span class="form-label">Table name</span>
						<input id="tableName" class="form-input" type="text" maxlength="64" required autocomplete="off">
					</label>
					<div>
						<div class="columns-header">
							<strong>Columns</strong>
							<button id="addColumn" class="icon-button" type="button" title="Add column" aria-label="Add column"><i class="codicon codicon-add"></i></button>
						</div>
						<div id="columnList" class="column-list"></div>
					</div>
				</div>
				<div id="createTablePreview" class="sql-preview" hidden>
					<span class="form-label">SQL to execute</span>
					<pre id="createTableSql"></pre>
				</div>
			</div>
			<div class="dialog-footer">
				<p id="createTableError" class="dialog-error" role="alert"></p>
				<button id="cancelCreateTable" class="button secondary" type="button">Cancel</button>
				<button id="saveCreateTable" class="button" type="submit">Review SQL</button>
			</div>
		</form>
	</dialog>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const previousState = vscode.getState() || {};
		const elements = {
			refresh: document.getElementById('refreshButton'),
			createDatabase: document.getElementById('createDatabaseButton'),
			importDatabase: document.getElementById('importDatabaseButton'),
			createTable: document.getElementById('createTableButton'),
			sql: document.getElementById('sqlButton'),
			databaseList: document.getElementById('databaseList'),
			listView: document.getElementById('listViewButton'),
			gridView: document.getElementById('gridViewButton'),
			columnHeader: document.getElementById('columnHeader'),
			tableList: document.getElementById('tableList'),
			status: document.getElementById('status')
		};
		const state = { database: previousState.database || ${JSON.stringify(server.database)}, databases: [], tables: [], view: previousState.view === 'grid' ? 'grid' : 'list' };
		const createTableDialog = document.getElementById('createTableDialog');
		const createTableTitle = document.getElementById('createTableTitle');
		const createTableForm = document.getElementById('createTableForm');
		const tableDefinitionFields = document.getElementById('tableDefinitionFields');
		const tableName = document.getElementById('tableName');
		const columnList = document.getElementById('columnList');
		const createTablePreview = document.getElementById('createTablePreview');
		const createTableSql = document.getElementById('createTableSql');
		const createTableError = document.getElementById('createTableError');
		const cancelCreateTable = document.getElementById('cancelCreateTable');
		const saveCreateTable = document.getElementById('saveCreateTable');
		const columnTypes = ['BIGINT', 'INT', 'SMALLINT', 'TINYINT', 'DECIMAL', 'VARCHAR', 'CHAR', 'TEXT', 'LONGTEXT', 'BOOLEAN', 'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'JSON', 'BLOB'];
		let createTableConfirmationId;
		let editingTable;

		window.addEventListener('message', event => {
			const message = event.data;
			if (message.type === 'databases') renderDatabases(message.databases, message.selectedDatabase, message.forceSelection);
			if (message.type === 'tablesLoading') showStatus('Loading tables...');
			if (message.type === 'tables') { state.database = message.database; state.tables = message.tables; render(); }
			if (message.type === 'connectionError') showStatus(message.message, true);
			if (message.type === 'tablesError') showStatus(message.message, true);
			if (message.type === 'tableStatementExecuted') createTableDialog.close();
			if (message.type === 'tableCreateError') { createTableError.textContent = message.message; saveCreateTable.disabled = false; }
			if (message.type === 'tableStatementPreview') showCreateTablePreview(message.confirmationId, message.sql);
			if (message.type === 'tableDefinition') openEditTableDialog(message.table, message.definition);
			if (message.type === 'tableDefinitionError') { createTableError.textContent = message.message; cancelCreateTable.disabled = false; }
		});
		elements.refresh.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
		elements.createDatabase.addEventListener('click', () => vscode.postMessage({ type: 'createDatabase' }));
		elements.importDatabase.addEventListener('click', () => vscode.postMessage({ type: 'importDatabase' }));
		elements.createTable.addEventListener('click', openCreateTableDialog);
		elements.sql.addEventListener('click', () => vscode.postMessage({ type: 'openSql', database: state.database }));
		elements.listView.addEventListener('click', () => setView('list'));
		elements.gridView.addEventListener('click', () => setView('grid'));
		document.getElementById('closeCreateTable').addEventListener('click', () => createTableDialog.close());
		cancelCreateTable.addEventListener('click', () => createTableConfirmationId ? showCreateTableFields() : createTableDialog.close());
		document.getElementById('addColumn').addEventListener('click', () => columnList.append(createColumnRow()));
		createTableForm.addEventListener('submit', event => {
			event.preventDefault();
			createTableError.textContent = '';
			saveCreateTable.disabled = true;
			if (createTableConfirmationId) {
				vscode.postMessage({ type: 'confirmTableStatement', confirmationId: createTableConfirmationId });
				return;
			}
			const columns = [...columnList.querySelectorAll('.column-row')].map(row => ({
				name: row.querySelector('.column-name').value,
				originalName: row.dataset.originalName || undefined,
				type: row.querySelector('.column-type').value,
				length: row.querySelector('.column-length').value,
				nullable: row.querySelector('.column-nullable').checked,
				primaryKey: row.querySelector('.column-primary').checked,
				autoIncrement: row.querySelector('.column-auto-increment').checked,
				defaultKind: row.querySelector('.column-default-kind').value,
				defaultValue: row.querySelector('.column-default-value').value
			}));
			vscode.postMessage({
				type: editingTable ? 'previewAlterTable' : 'previewCreateTable',
				database: state.database,
				table: editingTable,
				definition: { name: tableName.value, columns }
			});
		});

		function openCreateTableDialog() {
			editingTable = undefined;
			createTableTitle.textContent = 'Create table';
			tableName.value = '';
			createTableError.textContent = '';
			showCreateTableFields();
			columnList.replaceChildren(
				createColumnRow({ name: 'id', type: 'BIGINT', primaryKey: true, autoIncrement: true }),
				createColumnRow({ name: 'name', type: 'VARCHAR', length: '255' })
			);
			createTableDialog.showModal();
			tableName.focus();
		}

		function requestEditTable(table) {
			editingTable = table;
			createTableConfirmationId = undefined;
			createTableTitle.textContent = 'Edit ' + table;
			createTableError.textContent = 'Loading table definition...';
			tableDefinitionFields.hidden = true;
			createTablePreview.hidden = true;
			cancelCreateTable.textContent = 'Cancel';
			cancelCreateTable.disabled = false;
			saveCreateTable.disabled = true;
			createTableDialog.showModal();
			vscode.postMessage({ type: 'loadTableDefinition', database: state.database, table });
		}

		function openEditTableDialog(table, definition) {
			if (editingTable !== table) return;
			createTableError.textContent = '';
			tableName.value = definition.name;
			columnList.replaceChildren(...definition.columns.map(column => createColumnRow(column)));
			showCreateTableFields();
			tableName.focus();
		}

		function showCreateTablePreview(confirmationId, sql) {
			createTableConfirmationId = confirmationId;
			createTableSql.textContent = sql;
			tableDefinitionFields.hidden = true;
			createTablePreview.hidden = false;
			cancelCreateTable.textContent = 'Back';
			saveCreateTable.textContent = editingTable ? 'Confirm changes' : 'Confirm create';
			saveCreateTable.disabled = false;
		}

		function showCreateTableFields() {
			createTableConfirmationId = undefined;
			createTableSql.textContent = '';
			tableDefinitionFields.hidden = false;
			createTablePreview.hidden = true;
			cancelCreateTable.textContent = 'Cancel';
			saveCreateTable.textContent = 'Review SQL';
			saveCreateTable.disabled = false;
		}

		function createColumnRow(initial = {}) {
			const row = document.createElement('div');
			row.className = 'column-row';
			row.dataset.originalName = initial.originalName || '';
			const name = document.createElement('input');
			name.className = 'form-input column-name';
			name.type = 'text';
			name.maxLength = 64;
			name.placeholder = 'Column name';
			name.required = true;
			name.value = initial.name || '';
			const type = document.createElement('select');
			type.className = 'form-select column-type';
			for (const value of columnTypes) {
				const option = document.createElement('option');
				option.value = value;
				option.textContent = value;
				type.append(option);
			}
			type.value = initial.type || 'VARCHAR';
			const length = document.createElement('input');
			length.className = 'form-input column-length';
			length.type = 'text';
			length.placeholder = 'Length';
			length.pattern = '[0-9]+(,[0-9]+)?';
			length.value = initial.length || '';
			const nullable = createCheckbox('Nullable', 'column-nullable', initial.nullable);
			const primary = createCheckbox('Primary', 'column-primary', initial.primaryKey);
			const autoIncrement = createCheckbox('Auto increment', 'column-auto-increment', initial.autoIncrement);
			const nullableInput = nullable.querySelector('input');
			const primaryInput = primary.querySelector('input');
			const autoIncrementInput = autoIncrement.querySelector('input');
			const updateColumnState = () => {
				const supportsLength = ['DECIMAL', 'VARCHAR', 'CHAR'].includes(type.value);
				length.disabled = !supportsLength;
				length.required = type.value === 'VARCHAR' || type.value === 'CHAR';
				if (!supportsLength) length.value = '';
				if (primaryInput.checked) nullableInput.checked = false;
				if (autoIncrementInput.checked) {
					if (!['BIGINT', 'INT', 'SMALLINT', 'TINYINT'].includes(type.value)) type.value = 'BIGINT';
					primaryInput.checked = true;
					nullableInput.checked = false;
				}
			};
			type.addEventListener('change', updateColumnState);
			primaryInput.addEventListener('change', updateColumnState);
			autoIncrementInput.addEventListener('change', updateColumnState);
			updateColumnState();
			const defaultField = document.createElement('div');
			defaultField.className = 'default-field';
			const defaultKind = document.createElement('select');
			defaultKind.className = 'form-select column-default-kind';
			for (const [value, label] of [['none', 'No default'], ['null', 'NULL'], ['currentTimestamp', 'Current time'], ['value', 'Value']]) {
				const option = document.createElement('option');
				option.value = value;
				option.textContent = label;
				defaultKind.append(option);
			}
			defaultKind.value = initial.defaultKind || 'none';
			const defaultValue = document.createElement('input');
			defaultValue.className = 'form-input column-default-value';
			defaultValue.type = 'text';
			defaultValue.placeholder = 'Default value';
			defaultValue.value = initial.defaultValue || '';
			const updateDefaultValue = () => defaultValue.disabled = defaultKind.value !== 'value';
			defaultKind.addEventListener('change', updateDefaultValue);
			updateDefaultValue();
			defaultField.append(defaultKind, defaultValue);
			const remove = document.createElement('button');
			remove.className = 'icon-button';
			remove.type = 'button';
			remove.title = 'Remove column';
			remove.setAttribute('aria-label', remove.title);
			remove.innerHTML = '<i class="codicon codicon-trash"></i>';
			remove.addEventListener('click', () => row.remove());
			row.append(name, type, length, nullable, primary, autoIncrement, defaultField, remove);
			return row;
		}

		function createCheckbox(labelText, className, checked) {
			const label = document.createElement('label');
			label.className = 'column-option';
			const input = document.createElement('input');
			input.type = 'checkbox';
			input.className = className;
			input.checked = Boolean(checked);
			label.append(input, document.createTextNode(labelText));
			return label;
		}

		function renderDatabases(databases, selectedDatabase, forceSelection) {
			state.databases = databases;
			state.database = !forceSelection && databases.includes(state.database) ? state.database : selectedDatabase;
			elements.databaseList.replaceChildren(...databases.map(createDatabaseEntry));
			setDatabaseActionsDisabled(databases.length === 0);
			if (state.database !== selectedDatabase) vscode.postMessage({ type: 'selectDatabase', database: state.database });
			saveState();
		}

		function createDatabaseEntry(database) {
			const item = document.createElement('div');
			item.className = 'database-entry';
			item.classList.toggle('selected', database === state.database);
			item.dataset.database = database;
			item.setAttribute('role', 'option');
			item.setAttribute('aria-selected', String(database === state.database));
			const selectButton = document.createElement('button');
			selectButton.className = 'database-select';
			selectButton.type = 'button';
			selectButton.title = database;
			const icon = document.createElement('i');
			icon.className = 'codicon codicon-database';
			const label = document.createElement('span');
			label.textContent = database;
			selectButton.append(icon, label);
			selectButton.addEventListener('click', () => {
				if (database === state.database) return;
				state.database = database;
				updateDatabaseSelection();
				saveState();
				vscode.postMessage({ type: 'selectDatabase', database });
			});
			const exportButton = document.createElement('button');
			exportButton.className = 'icon-button database-item-action database-export';
			exportButton.type = 'button';
			exportButton.title = 'Export ' + database;
			exportButton.setAttribute('aria-label', exportButton.title);
			exportButton.innerHTML = '<i class="codicon codicon-cloud-upload"></i>';
			exportButton.addEventListener('click', () => vscode.postMessage({ type: 'exportDatabase', database }));
			const deleteButton = document.createElement('button');
			deleteButton.className = 'icon-button database-item-action database-delete';
			deleteButton.type = 'button';
			deleteButton.title = 'Delete ' + database;
			deleteButton.setAttribute('aria-label', deleteButton.title);
			deleteButton.innerHTML = '<i class="codicon codicon-trash"></i>';
			deleteButton.addEventListener('click', () => vscode.postMessage({ type: 'deleteDatabase', database }));
			item.append(selectButton, exportButton, deleteButton);
			return item;
		}

		function setDatabaseActionsDisabled(disabled) {
			elements.importDatabase.disabled = disabled;
			elements.createTable.disabled = disabled;
			elements.sql.disabled = disabled;
		}

		function render() {
			elements.tableList.replaceChildren(...state.tables.map(createTableEntry));
			elements.tableList.className = 'table-list ' + state.view + '-view';
			elements.columnHeader.hidden = state.view !== 'list';
			elements.status.hidden = state.tables.length !== 0;
			if (state.tables.length === 0) elements.status.textContent = 'No tables in this database.';
			updateDatabaseSelection();
			updateViewButtons();
			saveState();
		}

		function createTableEntry(table) {
			const item = document.createElement('div');
			item.className = 'table-entry';
			item.tabIndex = 0;
			item.setAttribute('role', 'option');
			item.title = table.name;
			const name = document.createElement('div');
			name.className = 'entry-name';
			const icon = document.createElement('span');
			icon.className = 'table-icon codicon codicon-table';
			const label = document.createElement('span');
			label.textContent = table.name;
			name.append(icon, label);
			const details = [
				['Rows', formatNumber(table.rowCount)],
				['Updated', formatDate(table.updatedAt)],
				['Data size', formatSize(table.dataSize + table.indexSize)]
			].map(([labelText, value]) => {
				const detail = document.createElement('span');
				detail.className = 'grid-detail';
				const detailLabel = document.createElement('span');
				detailLabel.className = 'grid-label';
				detailLabel.textContent = labelText;
				const detailValue = document.createElement('span');
				detailValue.className = 'grid-value entry-meta';
				detailValue.textContent = value;
				detailValue.title = value;
				detail.append(detailLabel, detailValue);
				return detail;
			});
			const detailContainer = document.createElement('div');
			detailContainer.className = 'grid-details';
			detailContainer.append(...details);
			const actions = document.createElement('div');
			actions.className = 'table-actions';
			const editButton = document.createElement('button');
			editButton.className = 'icon-button';
			editButton.type = 'button';
			editButton.title = 'Edit ' + table.name;
			editButton.setAttribute('aria-label', editButton.title);
			editButton.innerHTML = '<i class="codicon codicon-edit"></i>';
			editButton.addEventListener('click', event => {
				event.stopPropagation();
				requestEditTable(table.name);
			});
			editButton.addEventListener('dblclick', event => event.stopPropagation());
			const deleteButton = document.createElement('button');
			deleteButton.className = 'icon-button';
			deleteButton.type = 'button';
			deleteButton.title = 'Delete ' + table.name;
			deleteButton.setAttribute('aria-label', deleteButton.title);
			deleteButton.innerHTML = '<i class="codicon codicon-trash"></i>';
			deleteButton.addEventListener('click', event => {
				event.stopPropagation();
				vscode.postMessage({ type: 'deleteTable', database: state.database, table: table.name });
			});
			deleteButton.addEventListener('dblclick', event => event.stopPropagation());
			actions.append(editButton, deleteButton);
			item.append(name, detailContainer, actions);
			item.addEventListener('click', () => {
				elements.tableList.querySelectorAll('.table-entry.selected').forEach(element => element.classList.remove('selected'));
				item.classList.add('selected');
				item.focus({ preventScroll: true });
			});
			item.addEventListener('dblclick', () => vscode.postMessage({ type: 'openTable', database: state.database, table: table.name }));
			return item;
		}

		function setView(view) { state.view = view; render(); }
		function updateDatabaseSelection() {
			for (const item of elements.databaseList.querySelectorAll('.database-entry')) {
				const selected = item.dataset.database === state.database;
				item.classList.toggle('selected', selected);
				item.setAttribute('aria-selected', String(selected));
			}
		}
		function updateViewButtons() {
			const isList = state.view === 'list';
			elements.listView.classList.toggle('selected', isList);
			elements.gridView.classList.toggle('selected', !isList);
			elements.listView.setAttribute('aria-pressed', String(isList));
			elements.gridView.setAttribute('aria-pressed', String(!isList));
		}
		function showStatus(message, isError) {
			elements.tableList.replaceChildren();
			elements.status.textContent = message;
			elements.status.classList.toggle('error', Boolean(isError));
			elements.status.hidden = false;
		}
		function saveState() { vscode.setState({ database: state.database, view: state.view }); }
		function formatNumber(value) { return new Intl.NumberFormat().format(value); }
		function formatSize(bytes) {
			if (!bytes) return '0 B';
			const units = ['B', 'KB', 'MB', 'GB', 'TB'];
			const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
			return (bytes / Math.pow(1024, index)).toLocaleString(undefined, { maximumFractionDigits: index === 0 ? 0 : 1 }) + ' ' + units[index];
		}
		function formatDate(value) { return value ? new Date(value.replace(' ', 'T')).toLocaleString() : '—'; }
		updateViewButtons();
	</script>
</body>
</html>`;
}

function renderTablePreview(webview: vscode.Webview, extensionUri: vscode.Uri, database: string, table: string): string {
	const nonce = createNonce();
	const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(codiconsDistUri(extensionUri), 'codicon.css'));
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<link rel="stylesheet" href="${codiconsUri}">
	<title>${escapeHtml(table)}</title>
	<style>
		:root { color-scheme: light dark; }
		* { box-sizing: border-box; }
		html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
		body { display: grid; grid-template-rows: 42px minmax(0, 1fr); padding: 0 4px; }
		button, select, input, textarea { font: inherit; }
		header { position: relative; z-index: 2; display: flex; align-items: center; gap: 12px; padding: 0 10px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
		.path { min-width: 0; overflow: hidden; font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
		#createRow { margin-left: auto; }
		.pagination { display: flex; align-items: center; gap: 6px; }
		.count, .page-status { color: var(--vscode-descriptionForeground); font-size: 12px; white-space: nowrap; }
		.page-size { height: 26px; padding: 2px 22px 2px 7px; border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: 4px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); }
		.icon-button { display: inline-grid; width: 26px; height: 26px; padding: 0; place-items: center; border: 0; border-radius: 4px; color: var(--vscode-icon-foreground); background: transparent; cursor: pointer; }
		.icon-button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
		.icon-button:disabled { opacity: 0.4; cursor: default; }
		.icon-button:focus-visible, .page-size:focus-visible, .column-sort:focus-visible, .column-filter:focus-visible, .field-input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
		.content-clip { min-width: 0; min-height: 0; overflow: hidden; }
		#content { width: 100%; height: 100%; overflow: auto; }
		.status { display: grid; height: 100%; padding: 24px; place-items: center; color: var(--vscode-descriptionForeground); text-align: center; }
		.error { color: var(--vscode-errorForeground); white-space: pre-wrap; }
		table { width: max-content; min-width: 100%; border-collapse: separate; border-spacing: 0; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
		th, td { max-width: 420px; height: 28px; overflow: hidden; padding: 5px 10px; border-right: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); text-align: left; text-overflow: ellipsis; white-space: nowrap; }
		thead { position: relative; z-index: 2; }
		th { position: sticky; top: 0; z-index: 2; padding: 0; background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 12px; font-weight: 600; }
		.column-heading { display: grid; grid-template-columns: minmax(80px, 1fr) auto; align-items: center; min-width: 150px; }
		.column-name { min-width: 0; padding: 5px 4px 5px 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.sort-controls { display: grid; grid-template-rows: 14px 14px; width: 20px; height: 28px; }
		.column-sort { display: inline-grid; width: 20px; height: 14px; padding: 0; place-items: center; border: 0; color: var(--vscode-descriptionForeground); background: transparent; cursor: pointer; }
		.column-sort:hover, .column-sort[aria-pressed="true"] { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
		.sort-arrow { width: 0; height: 0; border-right: 4px solid transparent; border-left: 4px solid transparent; opacity: 0.55; }
		.sort-arrow.up { border-bottom: 6px solid currentColor; }
		.sort-arrow.down { border-top: 6px solid currentColor; }
		.sort-arrow.active { color: var(--vscode-foreground); opacity: 1; }
		.column-filter { grid-column: 1 / -1; width: calc(100% - 12px); height: 24px; margin: 0 6px 5px; padding: 2px 6px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; color: var(--vscode-input-foreground); background: transparent; }
		.column-filter::placeholder { color: var(--vscode-input-placeholderForeground); }
		tr:hover td { background: var(--vscode-list-hoverBackground); }
		.null { color: var(--vscode-descriptionForeground); font-style: italic; }
		.action-column, .row-action { position: sticky; right: 0; width: 58px; min-width: 58px; max-width: 58px; padding: 0; text-align: center; }
		.action-column { z-index: 1; background: var(--vscode-editor-background); }
		.row-action { z-index: 1; background: var(--vscode-editor-background); }
		.row-actions { display: flex; align-items: center; justify-content: center; gap: 2px; background: transparent; }
		tr:hover .row-action { background: var(--vscode-list-hoverBackground); }
		dialog { width: min(680px, calc(100vw - 32px)); max-height: min(760px, calc(100vh - 32px)); padding: 0; overflow: hidden; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 6px; color: var(--vscode-foreground); background: var(--vscode-editor-background); box-shadow: 0 12px 38px rgba(0, 0, 0, 0.35); }
		dialog::backdrop { background: rgba(0, 0, 0, 0.45); }
		.edit-form { display: grid; max-height: inherit; grid-template-rows: auto minmax(0, 1fr) auto; }
		.dialog-header, .dialog-footer { display: flex; min-height: 48px; padding: 8px 14px; align-items: center; gap: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
		.dialog-header h2 { min-width: 0; margin: 0; overflow: hidden; font-size: 14px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
		.dialog-header .icon-button { margin-left: auto; }
		.dialog-fields { display: grid; gap: 12px; padding: 14px; overflow: auto; }
		.edit-field { display: grid; gap: 5px; }
		.field-label { display: flex; align-items: center; gap: 7px; color: var(--vscode-descriptionForeground); font-size: 12px; }
		.field-label strong { color: var(--vscode-foreground); font-weight: 600; }
		.field-type { margin-left: auto; font-family: var(--vscode-editor-font-family); font-size: 11px; }
		.field-input { width: 100%; min-height: 28px; padding: 4px 7px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); resize: vertical; }
		.field-input:disabled { opacity: 0.55; }
		.null-toggle { display: inline-flex; align-items: center; gap: 4px; }
		.field-toggles { display: inline-flex; align-items: center; gap: 8px; }
		.dialog-error { min-height: 18px; margin: 0; color: var(--vscode-errorForeground); font-size: 12px; }
		.dialog-footer { justify-content: flex-end; border-top: 1px solid var(--vscode-panel-border); border-bottom: 0; }
		.button { min-width: 72px; height: 28px; padding: 3px 12px; border: 1px solid transparent; border-radius: 2px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
		.button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
		.button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
		.button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
		.button:disabled { opacity: 0.5; cursor: default; }
		@media (max-width: 620px) { .count { display: none; } header { gap: 6px; padding: 0 4px; } .pagination { gap: 2px; } }
	</style>
</head>
<body>
	<header>
		<span class="path">${escapeHtml(database)} › ${escapeHtml(table)}</span>
		<button id="createRow" class="icon-button" type="button" title="Create row" aria-label="Create row" disabled><i class="codicon codicon-add"></i></button>
		<nav class="pagination" aria-label="Table pagination">
			<span id="count" class="count">Loading...</span>
			<select id="pageSize" class="page-size" aria-label="Rows per page">
				<option value="50">50</option><option value="100" selected>100</option><option value="300">300</option><option value="500">500</option><option value="1000">1000</option>
			</select>
			<button id="previousPage" class="icon-button" type="button" title="Previous page" aria-label="Previous page" disabled><i class="codicon codicon-chevron-left"></i></button>
			<span id="pageStatus" class="page-status">1 / 1</span>
			<button id="nextPage" class="icon-button" type="button" title="Next page" aria-label="Next page" disabled><i class="codicon codicon-chevron-right"></i></button>
		</nav>
	</header>
	<div class="content-clip"><div id="content"><div class="status">Loading records...</div></div></div>
	<dialog id="editDialog" aria-labelledby="editDialogTitle">
		<form id="editForm" class="edit-form" method="dialog">
			<div class="dialog-header">
				<h2 id="editDialogTitle">Edit row</h2>
				<button id="closeDialog" class="icon-button" type="button" title="Close" aria-label="Close"><i class="codicon codicon-close"></i></button>
			</div>
			<div id="dialogFields" class="dialog-fields"></div>
			<div class="dialog-footer">
				<p id="dialogError" class="dialog-error" role="alert"></p>
				<button id="cancelEdit" class="button secondary" type="button">Cancel</button>
				<button id="saveEdit" class="button" type="submit">Save</button>
			</div>
		</form>
	</dialog>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const content = document.getElementById('content');
		const count = document.getElementById('count');
		const pageSize = document.getElementById('pageSize');
		const previousPage = document.getElementById('previousPage');
		const nextPage = document.getElementById('nextPage');
		const createRow = document.getElementById('createRow');
		const pageStatus = document.getElementById('pageStatus');
		const editDialog = document.getElementById('editDialog');
		const editDialogTitle = document.getElementById('editDialogTitle');
		const editForm = document.getElementById('editForm');
		const dialogFields = document.getElementById('dialogFields');
		const dialogError = document.getElementById('dialogError');
		const cancelEdit = document.getElementById('cancelEdit');
		const saveEdit = document.getElementById('saveEdit');
		let currentPage = 1;
		let totalPages = 1;
		let sort;
		let editingRow;
		let dialogMode = 'view';
		let tableMessage;
		let tableBody;
		let columnHeaders = [];
		const filters = new Map();
		let filterTimer;
		window.addEventListener('message', event => {
			const message = event.data;
			if (message.type === 'tableLoading') { pageSize.disabled = true; if (!tableMessage) renderStatus('Loading records...'); }
			if (message.type === 'tableData') renderTable(message);
			if (message.type === 'tableError') renderError(message.message);
			if (message.type === 'rowUpdated') editDialog.close();
			if (message.type === 'rowUpdateError') { dialogError.textContent = message.message; saveEdit.disabled = false; }
			if (message.type === 'rowInserted') editDialog.close();
			if (message.type === 'rowInsertError') { dialogError.textContent = message.message; saveEdit.disabled = false; }
		});
		createRow.addEventListener('click', openCreateDialog);
		pageSize.addEventListener('change', () => loadPage(1));
		previousPage.addEventListener('click', () => loadPage(currentPage - 1));
		nextPage.addEventListener('click', () => loadPage(currentPage + 1));
		document.getElementById('closeDialog').addEventListener('click', () => editDialog.close());
		cancelEdit.addEventListener('click', () => editDialog.close());
		editForm.addEventListener('submit', event => {
			event.preventDefault();
			if (!tableMessage || (dialogMode === 'edit' && !editingRow)) return;
			const values = {};
			for (const field of dialogFields.querySelectorAll('.edit-field')) {
				const column = field.dataset.column;
				const input = field.querySelector('.field-input');
				const nullToggle = field.querySelector('.null-checkbox');
				const defaultToggle = field.querySelector('.default-checkbox');
				if (defaultToggle?.checked) continue;
				const value = nullToggle?.checked ? null : input.value;
				if (dialogMode === 'create') values[column] = value;
				else {
					const originalValue = editingRow.editValues[tableMessage.columns.indexOf(column)];
					if (value !== originalValue) values[column] = value;
				}
			}
			if (dialogMode === 'edit' && Object.keys(values).length === 0) { editDialog.close(); return; }
			dialogError.textContent = '';
			saveEdit.disabled = true;
			if (dialogMode === 'create') vscode.postMessage({ type: 'insertRow', values });
			else vscode.postMessage({ type: 'updateRow', rowId: editingRow.rowId, values });
		});
		function renderTable(message) {
			tableMessage = message;
			currentPage = message.page;
			totalPages = message.totalPages;
			sort = message.sort;
			filters.clear();
			for (const filter of message.filters) filters.set(filter.column, filter.value);
			pageSize.value = String(message.pageSize);
			pageSize.disabled = false;
			createRow.disabled = false;
			count.textContent = message.totalRows.toLocaleString() + (message.totalRows === 1 ? ' row' : ' rows');
			pageStatus.textContent = currentPage.toLocaleString() + ' / ' + totalPages.toLocaleString();
			previousPage.disabled = currentPage <= 1;
			nextPage.disabled = currentPage >= totalPages;
			if (message.columns.length === 0) { renderStatus('No columns'); return; }
			if (!tableBody) createTable(message.columns);
			updateSortControls();
			preserveColumnWidths();
			tableBody.replaceChildren();
			for (const row of message.rows) {
				const tableRow = tableBody.insertRow();
				for (const value of row.values) {
					const cell = tableRow.insertCell();
					if (value === null) { cell.textContent = 'NULL'; cell.className = 'null'; }
					else { cell.textContent = value; cell.title = value; }
				}
				const actionCell = tableRow.insertCell();
				actionCell.className = 'row-action';
				const actions = document.createElement('div');
				actions.className = 'row-actions';
				const viewButton = document.createElement('button');
				viewButton.className = 'icon-button';
				viewButton.type = 'button';
				viewButton.title = 'View row';
				viewButton.setAttribute('aria-label', viewButton.title);
				viewButton.innerHTML = '<i class="codicon codicon-eye"></i>';
				viewButton.addEventListener('click', () => openRowDialog(row, true));
				const editButton = document.createElement('button');
				editButton.className = 'icon-button';
				editButton.type = 'button';
				editButton.title = message.canEdit ? 'Edit row' : message.editDisabledReason;
				editButton.setAttribute('aria-label', editButton.title);
				editButton.disabled = !message.canEdit;
				editButton.innerHTML = '<i class="codicon codicon-edit"></i>';
				editButton.addEventListener('click', () => openRowDialog(row, false));
				actions.append(viewButton, editButton);
				actionCell.append(actions);
			}
		}
		function createTable(columns) {
			const table = document.createElement('table');
			const head = table.createTHead().insertRow();
			columnHeaders = [];
			for (const column of columns) {
				const cell = document.createElement('th');
				columnHeaders.push(cell);
				const heading = document.createElement('div');
				heading.className = 'column-heading';
				const columnName = document.createElement('span');
				columnName.className = 'column-name';
				columnName.textContent = column;
				const sortControls = document.createElement('span');
				sortControls.className = 'sort-controls';
				for (const sortDirection of ['asc', 'desc']) {
					const sortButton = document.createElement('button');
					sortButton.className = 'column-sort';
					sortButton.type = 'button';
					sortButton.dataset.column = column;
					sortButton.dataset.direction = sortDirection;
					sortButton.title = (sortDirection === 'asc' ? 'Sort ascending by ' : 'Sort descending by ') + column;
					sortButton.setAttribute('aria-label', sortButton.title);
					const sortIcon = document.createElement('i');
					sortIcon.className = 'sort-arrow ' + (sortDirection === 'asc' ? 'up' : 'down');
					sortButton.append(sortIcon);
					sortButton.addEventListener('click', () => {
						sort = sort?.column === column && sort.direction === sortDirection ? undefined : { column, direction: sortDirection };
						loadPage(1);
					});
					sortControls.append(sortButton);
				}
				const filter = document.createElement('input');
				filter.className = 'column-filter';
				filter.type = 'search';
				filter.placeholder = 'Filter';
				filter.setAttribute('aria-label', 'Filter ' + column);
				filter.value = filters.get(column) || '';
				filter.addEventListener('input', () => {
					if (filter.value) filters.set(column, filter.value);
					else filters.delete(column);
					clearTimeout(filterTimer);
					filterTimer = setTimeout(() => loadPage(1), 350);
				});
				filter.addEventListener('keydown', event => {
					if (event.key === 'Enter') { clearTimeout(filterTimer); loadPage(1); }
				});
				heading.append(columnName, sortControls, filter);
				cell.append(heading);
				head.append(cell);
			}
			const actionHeader = document.createElement('th');
			actionHeader.className = 'action-column';
			actionHeader.title = 'Row actions';
			head.append(actionHeader);
			tableBody = table.createTBody();
			content.replaceChildren(table);
		}
		function preserveColumnWidths() {
			for (const header of columnHeaders) {
				const width = header.getBoundingClientRect().width;
				if (width > 0) header.style.minWidth = width + 'px';
			}
		}
		function updateSortControls() {
			for (const sortButton of content.querySelectorAll('.column-sort')) {
				const active = sort?.column === sortButton.dataset.column && sort.direction === sortButton.dataset.direction;
				sortButton.setAttribute('aria-pressed', String(active));
				const sortIcon = sortButton.querySelector('.sort-arrow');
				if (sortIcon) {
					sortIcon.classList.toggle('active', active);
				}
			}
		}
		function openCreateDialog() { openRowDialog(undefined, false, true); }
		function openRowDialog(row, readOnly, creating = false) {
			dialogMode = creating ? 'create' : readOnly ? 'view' : 'edit';
			editingRow = dialogMode === 'edit' ? row : undefined;
			editDialogTitle.textContent = creating ? 'Create row' : readOnly ? 'View row' : 'Edit row';
			dialogError.textContent = '';
			cancelEdit.textContent = readOnly ? 'Close' : 'Cancel';
			saveEdit.hidden = readOnly;
			saveEdit.disabled = readOnly;
			dialogFields.replaceChildren(...tableMessage.columnInfo.filter(column => creating
				? column.editable && !column.autoIncrement
				: readOnly || column.editable).map(column => {
				const columnIndex = tableMessage.columns.indexOf(column.name);
				const value = creating ? '' : row.editValues[columnIndex];
				const field = document.createElement('label');
				field.className = 'edit-field';
				field.dataset.column = column.name;
				const label = document.createElement('span');
				label.className = 'field-label';
				const name = document.createElement('strong');
				name.textContent = column.name;
				const type = document.createElement('span');
				type.className = 'field-type';
				type.textContent = (column.boolean ? 'boolean' : column.dataType) + (column.primaryKey ? ' · primary key' : '');
				label.append(name);
				const toggles = document.createElement('span');
				toggles.className = 'field-toggles';
				let defaultToggle;
				if (creating && column.hasDefault) {
					const defaultLabel = document.createElement('span');
					defaultLabel.className = 'null-toggle';
					defaultToggle = document.createElement('input');
					defaultToggle.className = 'default-checkbox';
					defaultToggle.type = 'checkbox';
					defaultToggle.checked = true;
					defaultLabel.append(defaultToggle, document.createTextNode('DEFAULT'));
					toggles.append(defaultLabel);
				}
				let nullToggle;
				if (column.nullable && !readOnly) {
					const nullLabel = document.createElement('span');
					nullLabel.className = 'null-toggle';
					nullToggle = document.createElement('input');
					nullToggle.className = 'null-checkbox';
					nullToggle.type = 'checkbox';
					nullToggle.checked = value === null;
					nullLabel.append(nullToggle, document.createTextNode('NULL'));
					toggles.append(nullLabel);
				}
				label.append(toggles);
				label.append(type);
				const multiline = ['text', 'tinytext', 'mediumtext', 'longtext', 'json'].includes(column.dataType);
				const input = document.createElement(column.boolean ? 'select' : multiline ? 'textarea' : 'input');
				input.className = 'field-input';
				if (column.boolean) {
					for (const booleanValue of ['true', 'false']) {
						const option = document.createElement('option');
						option.value = booleanValue;
						option.textContent = booleanValue;
						input.append(option);
					}
				} else if (!multiline) input.type = inputType(column.dataType);
				input.value = readOnly && value === null ? 'NULL' : value ?? '';
				const updateInputState = () => {
					input.disabled = readOnly || Boolean(defaultToggle?.checked) || Boolean(nullToggle?.checked);
					input.required = creating && !column.nullable && !column.hasDefault;
				};
				if (defaultToggle) defaultToggle.addEventListener('change', () => {
					if (defaultToggle.checked && nullToggle) nullToggle.checked = false;
					updateInputState();
				});
				if (nullToggle) nullToggle.addEventListener('change', () => {
					if (nullToggle.checked && defaultToggle) defaultToggle.checked = false;
					updateInputState();
				});
				updateInputState();
				field.append(label, input);
				return field;
			}));
			editDialog.showModal();
			const firstInput = dialogFields.querySelector('.field-input:not(:disabled)');
			if (firstInput) firstInput.focus();
		}
		function inputType(dataType) {
			if (dataType === 'date') return 'date';
			if (dataType === 'time') return 'time';
			return 'text';
		}
		function loadPage(page) {
			previousPage.disabled = true;
			nextPage.disabled = true;
			vscode.postMessage({
				type: 'loadPage',
				page,
				pageSize: Number(pageSize.value),
				sort,
				filters: [...filters].map(([column, value]) => ({ column, value }))
			});
		}
		function renderStatus(message) {
			const element = document.createElement('div');
			element.className = 'status';
			element.textContent = message;
			tableBody = undefined;
			columnHeaders = [];
			content.replaceChildren(element);
		}
		function renderError(message) {
			const element = document.createElement('div');
			element.className = 'status error';
			element.textContent = message;
			tableBody = undefined;
			columnHeaders = [];
			content.replaceChildren(element);
			count.textContent = '';
			pageSize.disabled = false;
			createRow.disabled = true;
			previousPage.disabled = true;
			nextPage.disabled = true;
		}
	</script>
</body>
</html>`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

interface MysqlCreateTableDefinition {
	name: string;
	columns: MysqlCreateTableColumn[];
}

const createTableColumnTypes = new Set([
	'BIGINT', 'INT', 'SMALLINT', 'TINYINT', 'DECIMAL', 'VARCHAR', 'CHAR', 'TEXT', 'LONGTEXT',
	'BOOLEAN', 'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'JSON', 'BLOB',
]);
const integerColumnTypes = new Set(['BIGINT', 'INT', 'SMALLINT', 'TINYINT']);
const lengthColumnTypes = new Set(['DECIMAL', 'VARCHAR', 'CHAR']);
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
