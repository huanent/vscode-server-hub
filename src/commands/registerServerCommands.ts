import * as vscode from 'vscode';
import { openServerConnection, openServerForm } from '../editors/serverHubEditor';
import { Server, ServerType } from '../servers/server';
import { ServerStore } from '../servers/serverStore';
import { exportServer, exportServers, importServers } from '../servers/serverTransfer';
import { ServerGroupTreeItem, ServerTreeItem } from '../servers/serverTree';
import { toggleSftpForActiveTerminal } from '../ssh/sshTerminal';

const commandIds = {
	addServer: 'server-hub.addServer',
	importServers: 'server-hub.importServers',
	exportServers: 'server-hub.exportServers',
	exportServer: 'server-hub.exportServer',
	connectServer: 'server-hub.connectServer',
	copyHost: 'server-hub.copyHost',
	editServer: 'server-hub.editServer',
	renameGroup: 'server-hub.renameGroup',
	deleteServer: 'server-hub.deleteServer',
	openSftp: 'server-hub.openSftp',
} as const;

export function registerServerCommands(serverStore: ServerStore): vscode.Disposable {
	return vscode.Disposable.from(
		vscode.commands.registerCommand(commandIds.addServer, selectAndAddServer),
		vscode.commands.registerCommand(
			commandIds.importServers,
			() => importServers(serverStore),
		),
		vscode.commands.registerCommand(
			commandIds.exportServers,
			() => exportServers(serverStore),
		),
		vscode.commands.registerCommand(
			commandIds.exportServer,
			(item: ServerTreeItem, selectedItems?: ServerTreeItem[]) => exportServer(
				serverStore,
				getSelectedServers(item, selectedItems),
			),
		),
		vscode.commands.registerCommand(
			commandIds.connectServer,
			(item: ServerTreeItem) => openServerConnection(item.server),
		),
		vscode.commands.registerCommand(
			commandIds.copyHost,
			(item: ServerTreeItem) => vscode.env.clipboard.writeText(item.server.host),
		),
		vscode.commands.registerCommand(
			commandIds.editServer,
			(item: ServerTreeItem) => openServerForm(item.server.type, item.server),
		),
		vscode.commands.registerCommand(
			commandIds.renameGroup,
			(item: ServerGroupTreeItem) => renameGroup(serverStore, item),
		),
		vscode.commands.registerCommand(
			commandIds.deleteServer,
			(item: ServerTreeItem, selectedItems?: ServerTreeItem[]) => confirmAndDeleteServers(
				serverStore,
				getSelectedServers(item, selectedItems),
			),
		),
		vscode.commands.registerCommand(commandIds.openSftp, toggleSftpForActiveTerminal),
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

async function renameGroup(serverStore: ServerStore, item: ServerGroupTreeItem): Promise<void> {
	const group = await vscode.window.showInputBox({
		title: 'Rename Group',
		prompt: 'Enter a new group name',
		value: item.group,
		valueSelection: [0, item.group.length],
		validateInput: value => {
			const newGroup = value.trim();
			if (!newGroup) {
				return 'Group name is required';
			}
			if (newGroup !== item.group && serverStore.getGroups().includes(newGroup)) {
				return 'A group with this name already exists';
			}
			return undefined;
		},
	});
	const newGroup = group?.trim();
	if (!newGroup || newGroup === item.group) {
		return;
	}

	await serverStore.renameGroup(item.group, newGroup);
}

function getSelectedServers(item: ServerTreeItem, selectedItems?: ServerTreeItem[]): Server[] {
	return (selectedItems?.length ? selectedItems : [item])
		.filter(selectedItem => selectedItem instanceof ServerTreeItem)
		.map(selectedItem => selectedItem.server);
}

async function confirmAndDeleteServers(
	serverStore: ServerStore,
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
}