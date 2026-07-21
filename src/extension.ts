import * as vscode from 'vscode';
import { registerServerCommands } from './commands/registerServerCommands';
import { registerServerHubEditor } from './editors/serverHubEditor';
import { MysqlSqlEditorController } from './mysql/mysqlSqlEditor';
import { ServerStore } from './servers/serverStore';
import { ServerTreeDataProvider } from './servers/serverTree';
import { initializeSftpFileEditing } from './ssh/sshTerminal';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	await initializeSftpFileEditing(context);
	const serverStore = new ServerStore(context);
	const treeDataProvider = new ServerTreeDataProvider(serverStore);
	const mysqlSqlEditor = new MysqlSqlEditorController(context, serverStore);

	context.subscriptions.push(
		serverStore,
		treeDataProvider,
		mysqlSqlEditor,
		registerServerHubEditor(context, serverStore, (serverId, database, initialSql) => void mysqlSqlEditor.open(serverId, database, initialSql)),
		registerServerCommands(serverStore, treeDataProvider),
		vscode.window.createTreeView('server-hub.servers', {
			treeDataProvider,
			canSelectMany: true,
		}),
	);
}

export function deactivate(): void {}
