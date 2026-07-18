import * as vscode from 'vscode';
import { registerServerCommands } from './commands/registerServerCommands';
import { registerServerHubEditor } from './editors/serverHubEditor';
import { ServerStore } from './servers/serverStore';
import { ServerTreeDataProvider } from './servers/serverTree';

export function activate(context: vscode.ExtensionContext): void {
	const serverStore = new ServerStore(context);
	const treeDataProvider = new ServerTreeDataProvider(serverStore);

	context.subscriptions.push(
		serverStore,
		treeDataProvider,
		registerServerHubEditor(context, serverStore),
		registerServerCommands(serverStore),
		vscode.window.createTreeView('server-hub.servers', {
			treeDataProvider,
			canSelectMany: true,
		}),
	);
}

export function deactivate(): void {}
