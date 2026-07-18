import * as vscode from 'vscode';
import { Connection, createConnection, FieldPacket, RowDataPacket } from 'mysql2/promise';
import { MysqlServer } from './server';

interface MysqlEditorMessage {
	type: 'selectDatabase' | 'refresh' | 'openTable';
	database?: unknown;
	table?: unknown;
}

interface MysqlTableInfo {
	name: string;
	engine: string;
	rowCount: number;
	dataSize: number;
	indexSize: number;
	updatedAt: string | null;
	collation: string;
}

export function openMysqlEditor(server: MysqlServer, password: string): void {
	const panel = vscode.window.createWebviewPanel(
		'server-hub.mysqlEditor',
		server.name,
		vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	panel.iconPath = new vscode.ThemeIcon('database');
	panel.webview.html = renderMysqlOverview(panel.webview, server);

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
		if (message.type === 'selectDatabase' && typeof message.database === 'string' && databases.has(message.database)) {
			currentDatabase = message.database;
			await loadTables();
			return;
		}
		if (message.type === 'refresh') {
			await loadTables();
			return;
		}
		if (
			message.type === 'openTable'
			&& typeof message.database === 'string'
			&& typeof message.table === 'string'
			&& message.database === currentDatabase
			&& tables.has(message.table)
		) {
			openMysqlTablePreview(server, password, currentDatabase, message.table);
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
			const [rows] = await connection.query<RowDataPacket[]>(
				'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME',
			);
			databases = new Set(rows.map(row => String(row.name)));
			if (!databases.has(currentDatabase)) {
				currentDatabase = databases.values().next().value ?? '';
			}
			void panel.webview.postMessage({
				type: 'databases',
				databases: [...databases],
				selectedDatabase: currentDatabase,
			});
			await loadTables();
		} catch (error) {
			void panel.webview.postMessage({ type: 'connectionError', message: errorMessage(error) });
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

function openMysqlTablePreview(server: MysqlServer, password: string, database: string, table: string): void {
	const panel = vscode.window.createWebviewPanel(
		'server-hub.mysqlTablePreview',
		`${table} - ${database}`,
		vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	panel.iconPath = new vscode.ThemeIcon('table');
	panel.webview.html = renderTablePreview(panel.webview, database, table);

	let connection: Connection | undefined;
	let disposed = false;
	panel.onDidDispose(() => {
		disposed = true;
		void connection?.end();
	});
	void loadPreview();

	async function loadPreview(): Promise<void> {
		try {
			connection = await createMysqlConnection(server, password, database);
			if (disposed) {
				await connection.end();
				return;
			}
			const [rows, fields] = await connection.query<RowDataPacket[]>('SELECT * FROM ??.?? LIMIT 100', [database, table]);
			void panel.webview.postMessage({
				type: 'tableData',
				columns: fields.map((field: FieldPacket) => field.name),
				rows: rows.map(row => fields.map((field: FieldPacket) => displayValue(row[field.name]))),
			});
		} catch (error) {
			void panel.webview.postMessage({ type: 'tableError', message: errorMessage(error) });
		}
	}
}

function createMysqlConnection(server: MysqlServer, password: string, database?: string): Promise<Connection> {
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

function normalizeTableInfo(row: RowDataPacket): MysqlTableInfo {
	return {
		name: String(row.name),
		engine: row.engine ? String(row.engine) : '',
		rowCount: Number(row.rowCount) || 0,
		dataSize: Number(row.dataSize) || 0,
		indexSize: Number(row.indexSize) || 0,
		updatedAt: row.updatedAt ? String(row.updatedAt) : null,
		collation: row.collation ? String(row.collation) : '',
	};
}

function displayValue(value: unknown): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (Buffer.isBuffer(value)) {
		return `0x${value.toString('hex')}`;
	}
	if (typeof value === 'object') {
		return JSON.stringify(value);
	}
	return String(value);
}

function renderMysqlOverview(webview: vscode.Webview, server: MysqlServer): string {
	const nonce = crypto.randomUUID().replaceAll('-', '');
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<title>${escapeHtml(server.name)}</title>
	<style>
		:root { color-scheme: light dark; }
		* { box-sizing: border-box; }
		html, body { width: 100%; min-width: 300px; height: 100%; margin: 0; overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
		body { padding: 4px; user-select: none; }
		button, select { font: inherit; }
		.toolbar { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; height: 46px; padding: 0 12px 4px; border-bottom: 1px solid var(--vscode-panel-border); }
		.primary-actions, .view-actions { display: flex; align-items: center; gap: 2px; }
		.view-actions { padding: 2px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; background: var(--vscode-input-background); }
		.icon-button { display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 4px; color: var(--vscode-icon-foreground); background: transparent; cursor: pointer; }
		.icon-button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
		.icon-button.selected { background: var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground)); }
		.icon-button:focus-visible, select:focus-visible, .table-entry:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
		.database-path { display: flex; min-width: 0; align-items: center; gap: 8px; }
		.connection-name { flex: 0 1 auto; min-width: 0; overflow: hidden; color: var(--vscode-breadcrumb-foreground); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
		.separator { color: var(--vscode-breadcrumb-foreground); }
		#databaseSelect { min-width: 120px; max-width: 280px; height: 26px; padding: 2px 24px 2px 7px; border: 1px solid var(--vscode-dropdown-border, transparent); color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); }
		main { height: calc(100% - 46px); overflow: auto; }
		.column-header, .table-list.list-view .table-entry { display: grid; grid-template-columns: minmax(190px, 1fr) 110px 110px 130px minmax(160px, 210px); align-items: center; }
		.column-header { position: sticky; top: 0; z-index: 2; height: 30px; padding: 0 14px 0 20px; border-bottom: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); font-size: 12px; }
		.column-header span:not(:first-child) { text-align: right; }
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
		.table-list.grid-view { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; padding: 14px 8px; }
		.table-list.grid-view .table-entry { display: grid; grid-template-rows: auto auto; gap: 12px; min-width: 0; min-height: 116px; padding: 14px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
		.table-list.grid-view .table-entry:hover { border-color: var(--vscode-focusBorder); }
		.table-list.grid-view .entry-name { align-items: flex-start; font-weight: 600; }
		.table-list.grid-view .table-icon { font-size: 22px; }
		.grid-details { display: grid; grid-template-columns: 1fr 1fr; gap: 7px 12px; }
		.grid-detail { min-width: 0; }
		.grid-label { display: block; margin-bottom: 2px; color: var(--vscode-descriptionForeground); font-size: 11px; }
		.grid-value { display: block; overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
		.table-list.list-view .grid-details { display: contents; }
		.table-list.list-view .grid-detail { display: contents; }
		.table-list.list-view .grid-label { display: none; }
		.status { padding: 44px 0; color: var(--vscode-descriptionForeground); text-align: center; }
		.error { color: var(--vscode-errorForeground); }
		@media (max-width: 760px) { .column-header, .table-list.list-view .table-entry { grid-template-columns: minmax(180px, 1fr) 90px 110px; } .column-header span:nth-child(3), .column-header span:nth-child(5), .table-list.list-view .grid-detail:nth-child(2), .table-list.list-view .grid-detail:nth-child(4) { display: none; } .connection-name { display: none; } }
	</style>
</head>
<body>
	<header class="toolbar">
		<div class="primary-actions" role="toolbar" aria-label="Database actions">
			<button id="refreshButton" class="icon-button" type="button" title="Refresh tables" aria-label="Refresh tables">↻</button>
		</div>
		<div class="database-path">
			<span class="connection-name" title="${escapeHtml(`${server.username}@${server.host}:${server.port}`)}">${escapeHtml(server.name)}</span>
			<span class="separator">›</span>
			<select id="databaseSelect" aria-label="Database" disabled><option>Connecting...</option></select>
		</div>
		<div class="view-actions" role="group" aria-label="View">
			<button id="listViewButton" class="icon-button selected" type="button" title="List view" aria-label="List view" aria-pressed="true">☷</button>
			<button id="gridViewButton" class="icon-button" type="button" title="Grid view" aria-label="Grid view" aria-pressed="false">▦</button>
		</div>
	</header>
	<main>
		<div id="columnHeader" class="column-header"><span>Name</span><span>Est. rows</span><span>Engine</span><span>Data size</span><span>Updated</span></div>
		<div id="tableList" class="table-list list-view" role="listbox" aria-label="Tables"></div>
		<div id="status" class="status" role="status" aria-live="polite">Connecting...</div>
	</main>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const previousState = vscode.getState() || {};
		const elements = {
			refresh: document.getElementById('refreshButton'),
			database: document.getElementById('databaseSelect'),
			listView: document.getElementById('listViewButton'),
			gridView: document.getElementById('gridViewButton'),
			columnHeader: document.getElementById('columnHeader'),
			tableList: document.getElementById('tableList'),
			status: document.getElementById('status')
		};
		const state = { database: previousState.database || ${JSON.stringify(server.database)}, tables: [], view: previousState.view === 'grid' ? 'grid' : 'list' };

		window.addEventListener('message', event => {
			const message = event.data;
			if (message.type === 'databases') renderDatabases(message.databases, message.selectedDatabase);
			if (message.type === 'tablesLoading') showStatus('Loading tables...');
			if (message.type === 'tables') { state.database = message.database; state.tables = message.tables; render(); }
			if (message.type === 'connectionError') showStatus(message.message, true);
			if (message.type === 'tablesError') showStatus(message.message, true);
		});
		elements.refresh.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
		elements.database.addEventListener('change', () => {
			state.database = elements.database.value;
			saveState();
			vscode.postMessage({ type: 'selectDatabase', database: state.database });
		});
		elements.listView.addEventListener('click', () => setView('list'));
		elements.gridView.addEventListener('click', () => setView('grid'));

		function renderDatabases(databases, selectedDatabase) {
			elements.database.replaceChildren(...databases.map(database => {
				const option = document.createElement('option');
				option.value = database;
				option.textContent = database;
				return option;
			}));
			state.database = databases.includes(state.database) ? state.database : selectedDatabase;
			elements.database.value = state.database;
			elements.database.disabled = databases.length === 0;
			if (state.database !== selectedDatabase) vscode.postMessage({ type: 'selectDatabase', database: state.database });
			saveState();
		}

		function render() {
			elements.tableList.replaceChildren(...state.tables.map(createTableEntry));
			elements.tableList.className = 'table-list ' + state.view + '-view';
			elements.columnHeader.hidden = state.view !== 'list';
			elements.status.hidden = state.tables.length !== 0;
			if (state.tables.length === 0) elements.status.textContent = 'No tables in this database.';
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
			icon.className = 'table-icon';
			icon.textContent = '▤';
			const label = document.createElement('span');
			label.textContent = table.name;
			name.append(icon, label);
			const details = [
				['Est. rows', formatNumber(table.rowCount)],
				['Engine', table.engine || '—'],
				['Data size', formatSize(table.dataSize + table.indexSize)],
				['Updated', formatDate(table.updatedAt)]
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

function renderTablePreview(webview: vscode.Webview, database: string, table: string): string {
	const nonce = crypto.randomUUID().replaceAll('-', '');
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<title>${escapeHtml(table)}</title>
	<style>
		:root { color-scheme: light dark; }
		* { box-sizing: border-box; }
		html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
		body { display: grid; grid-template-rows: 42px minmax(0, 1fr); }
		header { display: flex; align-items: center; gap: 8px; padding: 0 14px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorGroupHeader-tabsBackground); }
		.path { min-width: 0; overflow: hidden; font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
		.count { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 12px; white-space: nowrap; }
		#content { min-width: 0; overflow: auto; }
		.status { display: grid; height: 100%; padding: 24px; place-items: center; color: var(--vscode-descriptionForeground); text-align: center; }
		.error { color: var(--vscode-errorForeground); white-space: pre-wrap; }
		table { width: max-content; min-width: 100%; border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
		th, td { max-width: 420px; height: 28px; overflow: hidden; padding: 5px 10px; border-right: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); text-align: left; text-overflow: ellipsis; white-space: nowrap; }
		th { position: sticky; top: 0; z-index: 1; background: var(--vscode-editorGroupHeader-tabsBackground); font-family: var(--vscode-font-family); font-size: 12px; font-weight: 600; }
		tr:hover td { background: var(--vscode-list-hoverBackground); }
		.null { color: var(--vscode-descriptionForeground); font-style: italic; }
	</style>
</head>
<body>
	<header><span class="path">${escapeHtml(database)} › ${escapeHtml(table)}</span><span id="count" class="count">First 100 rows</span></header>
	<div id="content"><div class="status">Loading records...</div></div>
	<script nonce="${nonce}">
		const content = document.getElementById('content');
		const count = document.getElementById('count');
		window.addEventListener('message', event => {
			const message = event.data;
			if (message.type === 'tableData') renderTable(message);
			if (message.type === 'tableError') renderError(message.message);
		});
		function renderTable(message) {
			count.textContent = message.rows.length + (message.rows.length === 1 ? ' row' : ' rows') + ' · limit 100';
			if (message.columns.length === 0) { renderStatus('No columns'); return; }
			const table = document.createElement('table');
			const head = table.createTHead().insertRow();
			for (const column of message.columns) {
				const cell = document.createElement('th');
				cell.textContent = column;
				head.append(cell);
			}
			const body = table.createTBody();
			for (const row of message.rows) {
				const tableRow = body.insertRow();
				for (const value of row) {
					const cell = tableRow.insertCell();
					if (value === null) { cell.textContent = 'NULL'; cell.className = 'null'; }
					else { cell.textContent = value; cell.title = value; }
				}
			}
			content.replaceChildren(table);
		}
		function renderStatus(message) {
			const element = document.createElement('div');
			element.className = 'status';
			element.textContent = message;
			content.replaceChildren(element);
		}
		function renderError(message) {
			const element = document.createElement('div');
			element.className = 'status error';
			element.textContent = message;
			content.replaceChildren(element);
			count.textContent = '';
		}
	</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('"', '&quot;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
