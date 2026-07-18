import * as vscode from 'vscode';
import { Server, ServerType } from './server';
import { openServerConnection, openServerForm, registerServerHubEditor } from './serverHubEditor';
import { ServerStore } from './serverStore';
import { exportServers, importServers } from './serverTransfer';
import { ServerTreeDataProvider, ServerTreeItem } from './serverTree';
import { toggleSftpForActiveTerminal } from './sshTerminal';

export function activate(context: vscode.ExtensionContext): void {
	const serverStore = new ServerStore(context);
	const treeDataProvider = new ServerTreeDataProvider(serverStore);
	serverStore.enableSettingsSync();

	context.subscriptions.push(
		registerServerHubEditor(context, serverStore, treeDataProvider),
		vscode.window.registerTreeDataProvider('server-hub.servers', treeDataProvider),
		vscode.commands.registerCommand(
			'server-hub.addServer',
			() => selectAndAddServer(),
		),
		vscode.commands.registerCommand(
			'server-hub.importServers',
			() => importServers(serverStore, treeDataProvider),
		),
		vscode.commands.registerCommand(
			'server-hub.exportServers',
			() => exportServers(serverStore),
		),
		vscode.commands.registerCommand(
			'server-hub.connectServer',
			(item: ServerTreeItem) => openServerConnection(item.server),
		),
		vscode.commands.registerCommand(
			'server-hub.copyHost',
			(item: ServerTreeItem) => vscode.env.clipboard.writeText(item.server.host),
		),
		vscode.commands.registerCommand(
			'server-hub.editServer',
			(item: ServerTreeItem) => openServerForm(item.server.type, item.server),
		),
		vscode.commands.registerCommand(
			'server-hub.deleteServer',
			(item: ServerTreeItem) => confirmAndDeleteServer(serverStore, treeDataProvider, item.server),
		),
		vscode.commands.registerCommand('server-hub.openSftp', toggleSftpForActiveTerminal),
	);
}

async function selectAndAddServer(): Promise<void> {
	const selection = await vscode.window.showQuickPick<{ label: string; description: string; type: ServerType }>([
		{ label: 'SSH', description: 'Interactive remote terminal', type: 'ssh' },
		{ label: 'MySQL', description: 'Browse tables and preview data', type: 'mysql' },
	], { title: 'Add Server', placeHolder: 'Select a server type' });
	if (selection) {
		await openServerForm(selection.type);
	}
}

async function confirmAndDeleteServer(
	serverStore: ServerStore,
	treeDataProvider: ServerTreeDataProvider,
	server: Server,
): Promise<void> {
	const confirmation = await vscode.window.showWarningMessage(
		`Delete server “${server.name}”?`,
		{ modal: true },
		'Delete',
	);
	if (confirmation !== 'Delete') {
		return;
	}

	await serverStore.deleteServer(server.id);
	treeDataProvider.refresh();
}

export function deactivate(): void {}
