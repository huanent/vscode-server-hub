import * as vscode from 'vscode';
import { Connection, FieldPacket, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { MysqlServer } from '../servers/server';
import { codiconsDistUri, createNonce, escapeHtml } from '../webview/webviewUtils';
import { createMysqlConnection } from './mysqlConnection';
import { displayMysqlValue } from './tableData';
import { MysqlSqlEditorMessage } from './types';

export function configureMysqlSqlEditor(
	extensionUri: vscode.Uri,
	panel: vscode.WebviewPanel,
	server: MysqlServer,
	password: string,
	database: string,
): void {
	panel.title = `SQL - ${database}`;
	panel.webview.options = {
		enableScripts: true,
		localResourceRoots: [codiconsDistUri(extensionUri)],
	};
	panel.iconPath = new vscode.ThemeIcon('code');
	panel.webview.html = renderMysqlSqlEditor(panel.webview, extensionUri, server, database);

	let connection: Connection | undefined;
	let disposed = false;
	let executing = false;

	panel.onDidDispose(() => {
		disposed = true;
		void connection?.end();
	});
	panel.webview.onDidReceiveMessage(async (message: MysqlSqlEditorMessage) => {
		if (message.type !== 'executeSql' || typeof message.sql !== 'string' || executing) {
			return;
		}
		const sql = message.sql.trim();
		if (!sql) {
			return;
		}
		await executeSql(sql);
	});

	void connect();

	async function connect(): Promise<void> {
		try {
			connection = await createMysqlConnection(server, password, database);
			if (disposed) {
				await connection.end();
				return;
			}
			void panel.webview.postMessage({ type: 'ready' });
		} catch (error) {
			void panel.webview.postMessage({ type: 'connectionError', message: errorMessage(error) });
		}
	}

	async function executeSql(sql: string): Promise<void> {
		if (!connection) {
			return;
		}
		executing = true;
		void panel.webview.postMessage({ type: 'executing' });
		const startedAt = performance.now();
		try {
			const [result, fields] = await connection.query(sql);
			const durationMs = Math.round(performance.now() - startedAt);
			if (Array.isArray(result)) {
				const columns = (fields as FieldPacket[]).map(field => field.name);
				const rows = (result as RowDataPacket[]).map(row => columns.map(column => displayMysqlValue(row[column])));
				void panel.webview.postMessage({ type: 'queryResult', columns, rows, durationMs });
				return;
			}
			const commandResult = result as ResultSetHeader;
			void panel.webview.postMessage({
				type: 'commandResult',
				affectedRows: commandResult.affectedRows,
				insertId: commandResult.insertId,
				warningStatus: commandResult.warningStatus,
				durationMs,
			});
		} catch (error) {
			void panel.webview.postMessage({ type: 'queryError', message: errorMessage(error) });
		} finally {
			executing = false;
		}
	}
}

function renderMysqlSqlEditor(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	server: MysqlServer,
	database: string,
): string {
	const nonce = createNonce();
	const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(codiconsDistUri(extensionUri), 'codicon.css'));
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<link rel="stylesheet" href="${codiconsUri}">
	<title>SQL - ${escapeHtml(database)}</title>
	<style>
		:root { color-scheme: light dark; }
		* { box-sizing: border-box; }
		html, body { width: 100%; min-width: 320px; height: 100%; margin: 0; overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
		body { display: grid; grid-template-rows: minmax(150px, 32%) minmax(0, 1fr); }
		button, textarea { font: inherit; }
		.editor-pane { display: grid; grid-template-rows: 40px minmax(0, 1fr); min-height: 0; border-bottom: 1px solid var(--vscode-panel-border); }
		.toolbar { display: flex; align-items: center; gap: 8px; padding: 5px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
		.database-path { min-width: 0; flex: 1; overflow: hidden; color: var(--vscode-descriptionForeground); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
		.run-button { display: inline-flex; height: 28px; align-items: center; gap: 6px; padding: 0 10px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
		.run-button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
		.run-button:disabled { opacity: 0.55; cursor: default; }
		.run-button:focus-visible, textarea:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
		textarea { width: 100%; height: 100%; resize: none; padding: 12px 14px; border: 0; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.5; tab-size: 4; }
		.results-pane { position: relative; min-height: 0; overflow: auto; }
		.status { display: grid; min-height: 100%; place-items: center; padding: 24px; color: var(--vscode-descriptionForeground); text-align: center; }
		.status.error { color: var(--vscode-errorForeground); }
		.result-summary { position: sticky; top: 0; z-index: 3; min-height: 30px; padding: 7px 10px; border-bottom: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); font-size: 12px; }
		table { width: max-content; min-width: 100%; border-collapse: separate; border-spacing: 0; font-family: var(--vscode-editor-font-family); font-size: 12px; }
		th, td { max-width: 420px; padding: 6px 10px; overflow: hidden; border-right: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); text-align: left; text-overflow: ellipsis; white-space: pre; }
		th { position: sticky; top: 30px; z-index: 2; color: var(--vscode-foreground); background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background)); font-weight: 600; }
		td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
		tr:hover td { background: var(--vscode-list-hoverBackground); }
	</style>
</head>
<body>
	<section class="editor-pane">
		<header class="toolbar">
			<div class="database-path" title="${escapeHtml(`${server.name} / ${database}`)}">${escapeHtml(server.name)} / ${escapeHtml(database)}</div>
			<button id="runButton" class="run-button" type="button" disabled><i class="codicon codicon-play"></i><span>Run</span></button>
		</header>
		<textarea id="sqlInput" aria-label="SQL query" spellcheck="false" placeholder="SELECT * FROM table_name LIMIT 100;"></textarea>
	</section>
	<section id="results" class="results-pane" aria-live="polite"><div class="status">Connecting...</div></section>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const previousState = vscode.getState() || {};
		const sqlInput = document.getElementById('sqlInput');
		const runButton = document.getElementById('runButton');
		const results = document.getElementById('results');
		let ready = false;
		let executing = false;
		sqlInput.value = typeof previousState.sql === 'string' ? previousState.sql : '';
		sqlInput.addEventListener('input', () => {
			vscode.setState({ sql: sqlInput.value });
			updateRunButton();
		});
		sqlInput.addEventListener('keydown', event => {
			if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
				event.preventDefault();
				executeSql();
			}
		});
		runButton.addEventListener('click', executeSql);
		window.addEventListener('message', event => {
			const message = event.data;
			if (message.type === 'ready') { ready = true; renderStatus('Ready.'); updateRunButton(); sqlInput.focus(); }
			if (message.type === 'executing') { executing = true; renderStatus('Executing...'); updateRunButton(); }
			if (message.type === 'queryResult') { executing = false; renderTable(message); updateRunButton(); }
			if (message.type === 'commandResult') { executing = false; renderCommandResult(message); updateRunButton(); }
			if (message.type === 'connectionError' || message.type === 'queryError') { executing = false; renderStatus(message.message, true); updateRunButton(); }
		});

		function executeSql() {
			const sql = sqlInput.value.trim();
			if (!ready || executing || !sql) return;
			vscode.postMessage({ type: 'executeSql', sql });
		}
		function updateRunButton() { runButton.disabled = !ready || executing || sqlInput.value.trim().length === 0; }
		function renderStatus(message, error) {
			const status = document.createElement('div');
			status.className = 'status' + (error ? ' error' : '');
			status.textContent = message;
			results.replaceChildren(status);
		}
		function renderTable(message) {
			const summary = document.createElement('div');
			summary.className = 'result-summary';
			summary.textContent = message.rows.length.toLocaleString() + ' row(s) · ' + message.durationMs.toLocaleString() + ' ms';
			const table = document.createElement('table');
			const head = document.createElement('thead');
			const headRow = document.createElement('tr');
			headRow.append(...message.columns.map(column => {
				const cell = document.createElement('th');
				cell.textContent = column;
				cell.title = column;
				return cell;
			}));
			head.append(headRow);
			const body = document.createElement('tbody');
			body.append(...message.rows.map(row => {
				const tableRow = document.createElement('tr');
				tableRow.append(...row.map(value => {
					const cell = document.createElement('td');
					cell.textContent = value === null ? 'NULL' : value;
					cell.title = value === null ? 'NULL' : value;
					cell.classList.toggle('null', value === null);
					return cell;
				}));
				return tableRow;
			}));
			table.append(head, body);
			results.replaceChildren(summary, table);
		}
		function renderCommandResult(message) {
			const parts = [message.affectedRows.toLocaleString() + ' row(s) affected'];
			if (message.insertId) parts.push('insert id ' + message.insertId.toLocaleString());
			if (message.warningStatus) parts.push(message.warningStatus.toLocaleString() + ' warning(s)');
			parts.push(message.durationMs.toLocaleString() + ' ms');
			renderStatus(parts.join(' · '));
		}
		updateRunButton();
	</script>
</body>
</html>`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}