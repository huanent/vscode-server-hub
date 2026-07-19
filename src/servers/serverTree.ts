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
	constructor(readonly group: string, serverCount: number, expanded = false) {
		super(
			group || 'Ungrouped',
			expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
		);
		this.description = `${serverCount} items`;
		this.iconPath = new vscode.ThemeIcon('folder');
		this.contextValue = 'serverGroup';
	}
}

export type ServerTreeNode = ServerGroupTreeItem | ServerTreeItem;

export class ServerTreeDataProvider implements vscode.TreeDataProvider<ServerTreeNode>, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<ServerTreeNode | undefined>();
	readonly onDidChangeTreeData = this.changeEmitter.event;
	private readonly storeSubscription: vscode.Disposable;
	private filter = '';

	constructor(private readonly serverStore: ServerStore) {
		this.storeSubscription = serverStore.onDidChange(() => this.changeEmitter.fire(undefined));
	}

	getTreeItem(element: ServerTreeNode): vscode.TreeItem {
		return element;
	}

	getFilter(): string {
		return this.filter;
	}

	setFilter(filter: string): void {
		this.filter = filter.trim().toLocaleLowerCase();
		void vscode.commands.executeCommand('setContext', 'server-hub.serverFilterActive', Boolean(this.filter));
		this.changeEmitter.fire(undefined);
	}

	getChildren(element?: ServerTreeNode): ServerTreeNode[] {
		const servers = this.serverStore.getServers().filter(server => this.matchesFilter(server));
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
			.map(([group, serverCount]) => new ServerGroupTreeItem(group, serverCount, Boolean(this.filter)));
		return [...groups, ...ungroupedServers];
	}

	private matchesFilter(server: Server): boolean {
		if (!this.filter) {
			return true;
		}

		return [
			server.name,
			server.group,
			server.type,
			server.host,
			server.port.toString(),
			server.username,
			server.type === 'mysql' ? server.database : '',
		].some(value => value.toLocaleLowerCase().includes(this.filter));
	}

	dispose(): void {
		this.storeSubscription.dispose();
		this.changeEmitter.dispose();
	}
}