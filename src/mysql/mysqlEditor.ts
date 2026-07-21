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
	openSql: (database: string) => void,
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
					COLUMN_KEY AS columnKey, EXTRA AS extra, GENERATION_EXPRESSION AS generationExpression
				FROM information_schema.COLUMNS
				WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
				ORDER BY ORDINAL_POSITION`,
				[database, table],
			);
			columnInfo = metadataRows.map(row => ({
				name: String(row.name),
				dataType: String(row.dataType),
				boolean: String(row.dataType).toLowerCase() === 'bit' && String(row.columnType).toLowerCase() === 'bit(1)',
				nullable: row.isNullable === 'YES',
				primaryKey: row.columnKey === 'PRI',
				editable: !String(row.extra ?? '').includes('GENERATED') && !String(row.generationExpression ?? ''),
			}));
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
		button { font: inherit; }
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
		.column-header, .table-list.list-view .table-entry { display: grid; grid-template-columns: minmax(190px, 1fr) 110px minmax(160px, 210px) 130px; align-items: center; }
		.column-header { position: sticky; top: 0; z-index: 2; height: 30px; padding: 0 14px 0 18px; border-bottom: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); font-size: 12px; }
		.column-header[hidden] { display: none; }
		.column-header span:not(:first-child) { text-align: right; }
		.column-header span:nth-child(2), .column-header span:nth-child(3) { padding-left: 12px; text-align: left; }
		.table-list.list-view { padding: 4px 8px 12px; }
		.table-list.list-view .table-entry { min-height: 32px; padding: 0 6px 0 10px; border-radius: 3px; }
		.table-entry { color: var(--vscode-foreground); cursor: default; }
		.table-entry:hover { color: var(--vscode-list-hoverForeground); background: var(--vscode-list-hoverBackground); }
		.table-entry.selected { color: var(--vscode-list-inactiveSelectionForeground, var(--vscode-foreground)); background: var(--vscode-list-inactiveSelectionBackground); }
		.entry-name { display: flex; min-width: 0; align-items: center; gap: 8px; }
		.table-icon { display: inline-grid; flex: 0 0 auto; width: 17px; height: 17px; place-items: center; color: var(--vscode-symbolIcon-structForeground, var(--vscode-icon-foreground)); font-size: 15px; }
		.entry-name span:last-child, .entry-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.entry-meta { padding-left: 12px; color: var(--vscode-descriptionForeground); font-size: 12px; text-align: right; }
		.selected .entry-meta { color: inherit; }
		.table-list.grid-view { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); grid-auto-rows: 154px; gap: 10px; padding: 14px 8px; }
		.table-list.grid-view .table-entry { display: grid; grid-template-rows: 24px minmax(0, 1fr); gap: 12px; min-width: 0; height: 100%; padding: 14px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
		.table-list.grid-view .table-entry:hover { border-color: var(--vscode-focusBorder); }
		.table-list.grid-view .entry-name { align-items: center; font-weight: 600; }
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
		@media (max-width: 760px) { .workspace { grid-template-columns: 170px minmax(0, 1fr); } .column-header, .table-list.list-view .table-entry { grid-template-columns: minmax(180px, 1fr) 90px 110px; } .column-header span:nth-child(3), .table-list.list-view .grid-detail:nth-child(2) { display: none; } }
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
			<div id="columnHeader" class="column-header"><span>Name</span><span>Rows</span><span>Updated</span><span>Data size</span></div>
			<div id="tableList" class="table-list list-view" role="listbox" aria-label="Tables"></div>
			<div id="status" class="status" role="status" aria-live="polite">Connecting...</div>
		</main>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const previousState = vscode.getState() || {};
		const elements = {
			refresh: document.getElementById('refreshButton'),
			createDatabase: document.getElementById('createDatabaseButton'),
			importDatabase: document.getElementById('importDatabaseButton'),
			sql: document.getElementById('sqlButton'),
			databaseList: document.getElementById('databaseList'),
			listView: document.getElementById('listViewButton'),
			gridView: document.getElementById('gridViewButton'),
			columnHeader: document.getElementById('columnHeader'),
			tableList: document.getElementById('tableList'),
			status: document.getElementById('status')
		};
		const state = { database: previousState.database || ${JSON.stringify(server.database)}, databases: [], tables: [], view: previousState.view === 'grid' ? 'grid' : 'list' };

		window.addEventListener('message', event => {
			const message = event.data;
			if (message.type === 'databases') renderDatabases(message.databases, message.selectedDatabase, message.forceSelection);
			if (message.type === 'tablesLoading') showStatus('Loading tables...');
			if (message.type === 'tables') { state.database = message.database; state.tables = message.tables; render(); }
			if (message.type === 'connectionError') showStatus(message.message, true);
			if (message.type === 'tablesError') showStatus(message.message, true);
		});
		elements.refresh.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
		elements.createDatabase.addEventListener('click', () => vscode.postMessage({ type: 'createDatabase' }));
		elements.importDatabase.addEventListener('click', () => vscode.postMessage({ type: 'importDatabase' }));
		elements.sql.addEventListener('click', () => vscode.postMessage({ type: 'openSql', database: state.database }));
		elements.listView.addEventListener('click', () => setView('list'));
		elements.gridView.addEventListener('click', () => setView('grid'));

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
			item.append(name, detailContainer);
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
		.pagination { display: flex; margin-left: auto; align-items: center; gap: 6px; }
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
		});
		pageSize.addEventListener('change', () => loadPage(1));
		previousPage.addEventListener('click', () => loadPage(currentPage - 1));
		nextPage.addEventListener('click', () => loadPage(currentPage + 1));
		document.getElementById('closeDialog').addEventListener('click', () => editDialog.close());
		cancelEdit.addEventListener('click', () => editDialog.close());
		editForm.addEventListener('submit', event => {
			event.preventDefault();
			if (!editingRow || !tableMessage) return;
			const values = {};
			for (const field of dialogFields.querySelectorAll('.edit-field')) {
				const column = field.dataset.column;
				const input = field.querySelector('.field-input');
				const nullToggle = field.querySelector('.null-checkbox');
				const originalValue = editingRow.editValues[tableMessage.columns.indexOf(column)];
				const value = nullToggle?.checked ? null : input.value;
				if (value !== originalValue) values[column] = value;
			}
			if (Object.keys(values).length === 0) { editDialog.close(); return; }
			dialogError.textContent = '';
			saveEdit.disabled = true;
			vscode.postMessage({ type: 'updateRow', rowId: editingRow.rowId, values });
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
		function openRowDialog(row, readOnly) {
			editingRow = readOnly ? undefined : row;
			editDialogTitle.textContent = readOnly ? 'View row' : 'Edit row';
			dialogError.textContent = '';
			cancelEdit.textContent = readOnly ? 'Close' : 'Cancel';
			saveEdit.hidden = readOnly;
			saveEdit.disabled = readOnly;
			dialogFields.replaceChildren(...tableMessage.columnInfo.filter(column => readOnly || column.editable).map(column => {
				const columnIndex = tableMessage.columns.indexOf(column.name);
				const value = row.editValues[columnIndex];
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
				let nullToggle;
				if (column.nullable && !readOnly) {
					const nullLabel = document.createElement('span');
					nullLabel.className = 'null-toggle';
					nullToggle = document.createElement('input');
					nullToggle.className = 'null-checkbox';
					nullToggle.type = 'checkbox';
					nullToggle.checked = value === null;
					nullLabel.append(nullToggle, document.createTextNode('NULL'));
					label.append(nullLabel);
				}
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
				input.disabled = readOnly || value === null;
				if (nullToggle) nullToggle.addEventListener('change', () => { input.disabled = nullToggle.checked; });
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
