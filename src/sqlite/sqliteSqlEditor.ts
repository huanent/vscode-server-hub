import * as vscode from 'vscode';
import { DatabaseSync } from 'node:sqlite';
import { splitMysqlStatements } from '../mysql/sqlStatements';
import { getWebviewHtml } from '../webview';
import { displaySqliteValue, errorMessage } from './sqliteUtils';

const executeCommandId = 'server-hub.executeSqliteSql';
const activeContextKey = 'server-hub.sqliteSqlEditorActive';

interface SqlDocumentContext {
	databaseUri: vscode.Uri;
	temporaryDirectory: vscode.Uri;
}

type SqlResult =
	| { serverName: string; database: string; summary: string; kind: 'rows'; columns: string[]; rows: Array<Array<string | null>> }
	| { serverName: string; database: string; summary: string; kind: 'command'; message: string };

export class SqliteSqlEditorController implements vscode.Disposable {
	private readonly documents = new Map<string, SqlDocumentContext>();
	private readonly status: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[];
	private resultPanel: vscode.WebviewPanel | undefined;
	private currentResult: SqlResult | undefined;
	private resultReady = false;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
		this.status.name = 'SQLite SQL Connection';
		this.disposables = [
			this.status,
			vscode.commands.registerTextEditorCommand(executeCommandId, editor => this.execute(editor)),
			vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
			vscode.workspace.onDidCloseTextDocument(document => {
				const documentContext = this.documents.get(document.uri.toString());
				this.documents.delete(document.uri.toString());
				if (documentContext) void vscode.workspace.fs.delete(documentContext.temporaryDirectory, { recursive: true });
				this.updateContext();
			}),
		];
		this.updateContext();
	}

	async open(databaseUri: vscode.Uri, initialSql = ''): Promise<void> {
		const temporaryDirectory = vscode.Uri.joinPath(this.context.globalStorageUri, 'sqlite-sql', crypto.randomUUID());
		const databaseName = databaseUri.path.split('/').pop() ?? 'sqlite';
		const documentUri = vscode.Uri.joinPath(temporaryDirectory, `${safeFileName(databaseName)}.sql`);
		await vscode.workspace.fs.createDirectory(temporaryDirectory);
		await vscode.workspace.fs.writeFile(documentUri, Buffer.from(initialSql));
		const document = await vscode.workspace.openTextDocument(documentUri);
		this.documents.set(document.uri.toString(), { databaseUri, temporaryDirectory });
		await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Active });
		this.updateContext();
	}

	dispose(): void {
		void vscode.commands.executeCommand('setContext', activeContextKey, false);
		this.resultPanel?.dispose();
		for (const disposable of this.disposables) disposable.dispose();
	}

	private async execute(editor: vscode.TextEditor): Promise<void> {
		const documentContext = this.documents.get(editor.document.uri.toString());
		if (!documentContext) return;
		const sql = (editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection)).trim();
		if (!sql) return;
		const databaseName = documentContext.databaseUri.path.split('/').pop() ?? documentContext.databaseUri.fsPath;
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Executing SQLite SQL on ${databaseName}` }, async () => {
			const database = new DatabaseSync(documentContext.databaseUri.fsPath);
			const startedAt = performance.now();
			try {
				const statements = splitMysqlStatements(sql);
				let lastResult: SqlResult | undefined;
				for (let index = 0; index < statements.length; index++) {
					try {
						const statement = database.prepare(statements[index]);
						const columns = statement.columns().map(column => column.name);
						if (columns.length > 0) {
							const rows = statement.all() as Array<Record<string, unknown>>;
							lastResult = { serverName: 'SQLite', database: databaseName, summary: `${rows.length.toLocaleString()} row(s)`, kind: 'rows', columns, rows: rows.map(row => columns.map(column => displaySqliteValue(row[column]))) };
						} else {
							const result = statement.run();
							lastResult = { serverName: 'SQLite', database: databaseName, summary: `${result.changes.toLocaleString()} row(s) affected`, kind: 'command', message: 'Command completed successfully.' };
						}
					} catch (error) {
						throw new Error(`Statement ${index + 1} failed: ${errorMessage(error)}`);
					}
				}
				if (lastResult) {
					lastResult.summary += ` · ${Math.round(performance.now() - startedAt).toLocaleString()} ms`;
					this.showResult(lastResult);
				}
			} catch (error) {
				void vscode.window.showErrorMessage(`Could not execute SQLite SQL: ${errorMessage(error)}`);
			} finally {
				database.close();
			}
		});
	}

	private showResult(result: SqlResult): void {
		this.currentResult = result;
		const panel = this.getResultPanel();
		panel.title = `SQLite Results - ${result.database}`;
		if (this.resultReady) void panel.webview.postMessage({ type: 'result', result });
		panel.reveal(vscode.ViewColumn.Beside, true);
	}

	private getResultPanel(): vscode.WebviewPanel {
		if (this.resultPanel) return this.resultPanel;
		const panel = vscode.window.createWebviewPanel('server-hub.sqliteSqlResults', 'SQLite Results', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] });
		panel.iconPath = new vscode.ThemeIcon('table');
		panel.webview.html = getWebviewHtml(panel.webview, this.context.extensionUri, 'databaseSqlResults', 'SQLite Results');
		panel.webview.onDidReceiveMessage(message => {
			if (message?.type === 'ready') {
				this.resultReady = true;
				if (this.currentResult) void panel.webview.postMessage({ type: 'result', result: this.currentResult });
			}
		});
		panel.onDidDispose(() => { this.resultPanel = undefined; this.resultReady = false; });
		this.resultPanel = panel;
		return panel;
	}

	private updateContext(): void {
		const documentContext = vscode.window.activeTextEditor && this.documents.get(vscode.window.activeTextEditor.document.uri.toString());
		if (documentContext) {
			const name = documentContext.databaseUri.path.split('/').pop() ?? documentContext.databaseUri.fsPath;
			this.status.text = `$(database) ${name}`;
			this.status.tooltip = `SQLite database: ${documentContext.databaseUri.fsPath}`;
			this.status.show();
		} else {
			this.status.hide();
		}
		void vscode.commands.executeCommand('setContext', activeContextKey, Boolean(documentContext));
	}
}

function safeFileName(value: string): string {
	return value.replaceAll(/[\\/:*?"<>|\r\n]/g, '_').trim() || 'query';
}