import * as vscode from 'vscode';
import { Server } from './server';
import { ServerStore } from './serverStore';

export class ServerTreeItem extends vscode.TreeItem {
	constructor(readonly server: Server) {
		super(server.name, vscode.TreeItemCollapsibleState.None);
		this.description = server.type === 'mysql'
			? `${server.username}@${server.host}:${server.port}/${server.database}`
			: `${server.username}@${server.host}:${server.port}`;
		this.tooltip = `${server.name}\n${this.description}`;
		this.iconPath = new vscode.ThemeIcon(server.type === 'mysql' ? 'database' : 'terminal-linux');
		this.contextValue = `${server.type}Server`;
	}
}

export class ServerGroupTreeItem extends vscode.TreeItem {
	constructor(readonly group: string, serverCount: number) {
		super(group || 'Ungrouped', vscode.TreeItemCollapsibleState.Collapsed);
		this.description = `${serverCount} items`;
		this.iconPath = new vscode.ThemeIcon('folder');
		this.contextValue = 'serverGroup';
	}
}

export type ServerTreeNode = ServerGroupTreeItem | ServerTreeItem;

export class ServerTreeDataProvider implements vscode.TreeDataProvider<ServerTreeNode> {
	private readonly changeEmitter = new vscode.EventEmitter<ServerTreeNode | undefined>();
	readonly onDidChangeTreeData = this.changeEmitter.event;

	constructor(private readonly serverStore: ServerStore) {}

	getTreeItem(element: ServerTreeNode): vscode.TreeItem {
		return element;
	}

	getChildren(element?: ServerTreeNode): ServerTreeNode[] {
		const servers = this.serverStore.getServers();
		if (element instanceof ServerGroupTreeItem) {
			return servers
				.filter(server => server.group === element.group)
				.map(server => new ServerTreeItem(server));
		}
		if (element) {
			return [];
		}

		const groupedServers = new Map<string, number>();
		for (const server of servers) {
			if (server.group) {
				groupedServers.set(server.group, (groupedServers.get(server.group) ?? 0) + 1);
			}
		}
		const ungroupedServers = servers
			.filter(server => !server.group)
			.map(server => new ServerTreeItem(server));
		const groups = [...groupedServers]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([group, serverCount]) => new ServerGroupTreeItem(group, serverCount));
		return [...groups, ...ungroupedServers];
	}

	refresh(): void {
		this.changeEmitter.fire(undefined);
	}
}