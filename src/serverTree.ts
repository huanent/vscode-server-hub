import * as vscode from 'vscode';
import { SshServer } from './server';
import { ServerStore } from './serverStore';

export class ServerTreeItem extends vscode.TreeItem {
	constructor(readonly server: SshServer) {
		super(server.name, vscode.TreeItemCollapsibleState.None);
		this.description = `${server.username}@${server.host}:${server.port}`;
		this.tooltip = `${server.name}\n${this.description}`;
		this.iconPath = new vscode.ThemeIcon('terminal-secure');
		this.contextValue = 'sshServer';
	}
}

export class ServerTreeDataProvider implements vscode.TreeDataProvider<ServerTreeItem> {
	private readonly changeEmitter = new vscode.EventEmitter<ServerTreeItem | undefined>();
	readonly onDidChangeTreeData = this.changeEmitter.event;

	constructor(private readonly serverStore: ServerStore) {}

	getTreeItem(element: ServerTreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(): ServerTreeItem[] {
		return this.serverStore.getServers().map(server => new ServerTreeItem(server));
	}

	refresh(): void {
		this.changeEmitter.fire(undefined);
	}
}