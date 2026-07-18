import * as vscode from 'vscode';
import { Server, ServerType } from './server';
import { openServerConnection, openServerForm, registerServerHubEditor } from './serverHubEditor';
import { ServerStore } from './serverStore';
import { exportServer, exportServers, importServers } from './serverTransfer';
import { ServerTreeDataProvider, ServerTreeItem } from './serverTree';
import { toggleSftpForActiveTerminal } from './sshTerminal';

export function activate(context: vscode.ExtensionContext): void {
	const serverStore = new ServerStore(context);
	const treeDataProvider = new ServerTreeDataProvider(serverStore);

	context.subscriptions.push(
		registerServerHubEditor(context, serverStore, treeDataProvider),
		vscode.window.createTreeView('server-hub.servers', {
			treeDataProvider,
			canSelectMany: true,
		}),
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
			'server-hub.exportServer',
			(item: ServerTreeItem, selectedItems?: ServerTreeItem[]) => exportServer(
				serverStore,
				getSelectedServers(item, selectedItems),
			),
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
			(item: ServerTreeItem, selectedItems?: ServerTreeItem[]) => confirmAndDeleteServers(
				serverStore,
				treeDataProvider,
				getSelectedServers(item, selectedItems),
			),
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

function getSelectedServers(item: ServerTreeItem, selectedItems?: ServerTreeItem[]): Server[] {
	return (selectedItems?.length ? selectedItems : [item])
		.filter(selectedItem => selectedItem instanceof ServerTreeItem)
		.map(selectedItem => selectedItem.server);
}

async function confirmAndDeleteServers(
	serverStore: ServerStore,
	treeDataProvider: ServerTreeDataProvider,
	servers: Server[],
): Promise<void> {
	const confirmation = await vscode.window.showWarningMessage(
		servers.length === 1
			? `Delete server “${servers[0].name}”?`
			: `Delete ${servers.length} selected servers?`,
		{ modal: true },
		'Delete',
	);
	if (confirmation !== 'Delete') {
		return;
	}

	await serverStore.deleteServers(servers.map(server => server.id));
	treeDataProvider.refresh();
}

export function deactivate(): void {}
