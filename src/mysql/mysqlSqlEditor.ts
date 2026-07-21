import * as vscode from 'vscode';
import { FieldPacket, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { ServerStore } from '../servers/serverStore';
import { escapeHtml } from '../webview/webviewUtils';
import { createMysqlConnection } from './mysqlConnection';
import { displayMysqlValue } from './tableData';

const executeCommandId = 'server-hub.executeMysqlSql';
const activeContextKey = 'server-hub.mysqlSqlEditorActive';

interface SqlDocumentContext {
	serverId: string;
	database: string;
	temporaryDirectory: vscode.Uri;
}

export class MysqlSqlEditorController implements vscode.Disposable {
	private readonly documentContexts = new Map<string, SqlDocumentContext>();
	private readonly documentSaves = new Map<string, Promise<void>>();
	private readonly disposables: vscode.Disposable[];
	private resultPanel: vscode.WebviewPanel | undefined;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly serverStore: ServerStore,
	) {
		this.disposables = [
			vscode.commands.registerTextEditorCommand(executeCommandId, editor => this.execute(editor)),
			vscode.window.onDidChangeActiveTextEditor(() => this.updateActiveContext()),
			vscode.workspace.onDidChangeTextDocument(event => this.saveDocument(event.document)),
			vscode.workspace.onDidCloseTextDocument(document => {
				const documentKey = document.uri.toString();
				const documentContext = this.documentContexts.get(documentKey);
				this.documentContexts.delete(documentKey);
				const pendingSave = this.documentSaves.get(documentKey) ?? Promise.resolve();
				if (documentContext) {
					void pendingSave.finally(() => vscode.workspace.fs.delete(documentContext.temporaryDirectory, { recursive: true }));
				}
				this.updateActiveContext();
			}),
		];
		this.updateActiveContext();
	}

	async open(serverId: string, database: string): Promise<void> {
		const databaseLabel = database.replaceAll('\r', ' ').replaceAll('\n', ' ');
		const temporaryDirectory = vscode.Uri.joinPath(
			this.context.globalStorageUri,
			'mysql-sql',
			crypto.randomUUID(),
		);
		const documentUri = vscode.Uri.joinPath(temporaryDirectory, `${safeFileName(database)}.sql`);
		await vscode.workspace.fs.createDirectory(temporaryDirectory);
		await vscode.workspace.fs.writeFile(documentUri, new TextEncoder().encode(`-- Database: ${databaseLabel}\n\n`));
		const document = await vscode.workspace.openTextDocument(documentUri);
		this.documentContexts.set(document.uri.toString(), { serverId, database, temporaryDirectory });
		await vscode.window.showTextDocument(document, {
			preview: false,
			viewColumn: vscode.ViewColumn.Active,
		});
		this.updateActiveContext();
	}

	dispose(): void {
		void vscode.commands.executeCommand('setContext', activeContextKey, false);
		this.resultPanel?.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	private async execute(editor: vscode.TextEditor): Promise<void> {
		const context = this.documentContexts.get(editor.document.uri.toString());
		if (!context) {
			return;
		}
		const sql = (editor.selection.isEmpty
			? editor.document.getText()
			: editor.document.getText(editor.selection)).trim();
		if (!sql) {
			return;
		}

		const server = this.serverStore.getServers().find(candidate => candidate.id === context.serverId);
		if (!server || server.type !== 'mysql') {
			void vscode.window.showErrorMessage('The MySQL server no longer exists.');
			return;
		}
		const password = await this.serverStore.getPassword(server.id);
		if (!password) {
			void vscode.window.showErrorMessage(`No password is available for “${server.name}” on this device.`);
			return;
		}

		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Window,
			title: `Executing SQL on ${server.name} / ${context.database}`,
		}, async () => {
			const connection = await createMysqlConnection(server, password, context.database);
			const startedAt = performance.now();
			try {
				const [result, fields] = await connection.query(sql);
				const durationMs = Math.round(performance.now() - startedAt);
				if (Array.isArray(result)) {
					this.showRows(
						server.name,
						context.database,
						result as RowDataPacket[],
						fields as FieldPacket[],
						durationMs,
					);
				} else {
					this.showCommandResult(server.name, context.database, result as ResultSetHeader, durationMs);
				}
			} catch (error) {
				void vscode.window.showErrorMessage(`Could not execute SQL: ${errorMessage(error)}`);
			} finally {
				await connection.end();
			}
		});
	}

	private showRows(
		serverName: string,
		database: string,
		rows: RowDataPacket[],
		fields: FieldPacket[],
		durationMs: number,
	): void {
		const columns = fields.map(field => field.name);
		const header = columns.map(column => `<th title="${escapeHtml(column)}">${escapeHtml(column)}</th>`).join('');
		const body = rows.map(row => `<tr>${columns.map(column => {
			const value = displayMysqlValue(row[column]);
			const displayValue = value === null ? 'NULL' : value;
			return `<td class="${value === null ? 'null' : ''}" title="${escapeHtml(displayValue)}">${escapeHtml(displayValue)}</td>`;
		}).join('')}</tr>`).join('');
		this.showResult(
			serverName,
			database,
			`${rows.length.toLocaleString()} row(s) · ${durationMs.toLocaleString()} ms`,
			`<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`,
		);
	}

	private showCommandResult(
		serverName: string,
		database: string,
		result: ResultSetHeader,
		durationMs: number,
	): void {
		const parts = [`${result.affectedRows.toLocaleString()} row(s) affected`];
		if (result.insertId) {
			parts.push(`Insert id ${result.insertId.toLocaleString()}`);
		}
		if (result.warningStatus) {
			parts.push(`${result.warningStatus.toLocaleString()} warning(s)`);
		}
		parts.push(`${durationMs.toLocaleString()} ms`);
		this.showResult(serverName, database, parts.join(' · '), '<div class="empty">Command completed successfully.</div>');
	}

	private showResult(serverName: string, database: string, summary: string, content: string): void {
		const panel = this.getResultPanel();
		panel.title = `SQL Results - ${database}`;
		panel.webview.html = renderResultHtml(serverName, database, summary, content);
		panel.reveal(vscode.ViewColumn.Beside, true);
	}

	private getResultPanel(): vscode.WebviewPanel {
		if (this.resultPanel) {
			return this.resultPanel;
		}
		const panel = vscode.window.createWebviewPanel(
			'server-hub.mysqlSqlResults',
			'SQL Results',
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{},
		);
		panel.iconPath = new vscode.ThemeIcon('table');
		panel.onDidDispose(() => {
			this.resultPanel = undefined;
		});
		this.resultPanel = panel;
		return panel;
	}

	private updateActiveContext(): void {
		const active = vscode.window.activeTextEditor;
		const isActive = Boolean(active && this.documentContexts.has(active.document.uri.toString()));
		void vscode.commands.executeCommand('setContext', activeContextKey, isActive);
	}

	private saveDocument(document: vscode.TextDocument): void {
		const documentKey = document.uri.toString();
		if (!this.documentContexts.has(documentKey) || !document.isDirty) {
			return;
		}
		const previousSave = this.documentSaves.get(documentKey) ?? Promise.resolve();
		const nextSave = previousSave
			.then(async () => {
				while (!document.isClosed && document.isDirty) {
					if (!await document.save()) {
						break;
					}
				}
			})
			.finally(() => {
				if (this.documentSaves.get(documentKey) === nextSave) {
					this.documentSaves.delete(documentKey);
				}
			});
		this.documentSaves.set(documentKey, nextSave);
	}
}

function renderResultHtml(serverName: string, database: string, summary: string, content: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
	<title>SQL Results - ${escapeHtml(database)}</title>
	<style>
		:root { color-scheme: light dark; }
		* { box-sizing: border-box; }
		html, body { min-width: 320px; min-height: 100%; margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
		body { overflow: auto; }
		.summary { position: sticky; top: 0; z-index: 3; display: flex; min-height: 36px; align-items: center; justify-content: space-between; gap: 16px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); font-size: 12px; }
		.connection { min-width: 0; overflow: hidden; color: var(--vscode-descriptionForeground); text-overflow: ellipsis; white-space: nowrap; }
		.metrics { flex: none; }
		table { width: max-content; min-width: 100%; border-collapse: separate; border-spacing: 0; font-family: var(--vscode-editor-font-family); font-size: 12px; }
		th, td { max-width: 480px; padding: 6px 10px; overflow: hidden; border-right: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); text-align: left; text-overflow: ellipsis; white-space: pre; }
		th { position: sticky; top: 36px; z-index: 2; background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background)); font-weight: 600; }
		td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
		tr:hover td { background: var(--vscode-list-hoverBackground); }
		.empty { display: grid; min-height: 180px; place-items: center; padding: 24px; color: var(--vscode-descriptionForeground); text-align: center; }
	</style>
</head>
<body>
	<header class="summary">
		<div class="connection" title="${escapeHtml(`${serverName} / ${database}`)}">${escapeHtml(serverName)} / ${escapeHtml(database)}</div>
		<div class="metrics">${escapeHtml(summary)}</div>
	</header>
	${content}
</body>
</html>`;
}

function safeFileName(value: string): string {
	const fileName = value.replaceAll(/[\\/:*?"<>|\r\n]/g, '_').trim();
	return fileName || 'query';
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}