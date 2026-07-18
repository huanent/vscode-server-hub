import * as vscode from 'vscode';
import { openMysqlEditor } from './mysqlEditor';
import { Server, ServerType } from './server';
import { openServerForm } from './serverForm';
import { ServerStore } from './serverStore';
import { exportServers, importServers } from './serverTransfer';
import { ServerTreeDataProvider, ServerTreeItem } from './serverTree';
import { openSshTerminal } from './sshTerminal';

export function activate(context: vscode.ExtensionContext): void {
	const serverStore = new ServerStore(context);
	const treeDataProvider = new ServerTreeDataProvider(serverStore);
	serverStore.enableSettingsSync();

	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('server-hub.servers', treeDataProvider),
		vscode.commands.registerCommand(
			'server-hub.addServer',
			() => selectAndAddServer(context, serverStore, treeDataProvider),
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
			(item: ServerTreeItem) => connectToServer(context, serverStore, item.server),
		),
		vscode.commands.registerCommand(
			'server-hub.editServer',
			(item: ServerTreeItem) => openServerForm(context, serverStore, treeDataProvider, item.server.type, item.server),
		),
		vscode.commands.registerCommand(
			'server-hub.deleteServer',
			(item: ServerTreeItem) => confirmAndDeleteServer(serverStore, treeDataProvider, item.server),
		),
	);
}

async function selectAndAddServer(
	context: vscode.ExtensionContext,
	serverStore: ServerStore,
	treeDataProvider: ServerTreeDataProvider,
): Promise<void> {
	const selection = await vscode.window.showQuickPick<{ label: string; description: string; type: ServerType }>([
		{ label: 'SSH', description: 'Interactive remote terminal', type: 'ssh' },
		{ label: 'MySQL', description: 'Browse tables and preview data', type: 'mysql' },
	], { title: 'Add Server', placeHolder: 'Select a server type' });
	if (selection) {
		openServerForm(context, serverStore, treeDataProvider, selection.type);
	}
}

async function connectToServer(
	context: vscode.ExtensionContext,
	serverStore: ServerStore,
	server: Server,
): Promise<void> {
	const password = await serverStore.getPassword(server.id);
	if (!password) {
		void vscode.window.showErrorMessage(`No password is available for “${server.name}” on this device.`);
		return;
	}

	if (server.type === 'ssh') {
		openSshTerminal(server, password);
		return;
	}

	openMysqlEditor(context.extensionUri, server, password);
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
