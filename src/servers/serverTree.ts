import * as vscode from 'vscode';
import { Server } from './server';
import { ServerStore } from './serverStore';

export class ServerTreeItem extends vscode.TreeItem {
	constructor(readonly server: Server, canMoveUp = false, canMoveDown = false) {
		super(server.name, vscode.TreeItemCollapsibleState.None);
		this.description = serverDescription(server);
		this.tooltip = `${server.name}\n${this.description}`;
		this.iconPath = new vscode.ThemeIcon(server.type === 'mysql' ? 'database' : server.type === 'container' ? 'server-process' : 'terminal');
		this.contextValue = treeItemContext(`${server.type}Server`, canMoveUp, canMoveDown);
	}
}

export class ServerGroupTreeItem extends vscode.TreeItem {
	constructor(readonly group: string, serverCount: number, expanded = false, canMoveUp = false, canMoveDown = false) {
		super(
			group || 'Ungrouped',
			expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
		);
		this.description = `${serverCount} items`;
		this.iconPath = new vscode.ThemeIcon('folder');
		this.contextValue = treeItemContext('serverGroup', canMoveUp, canMoveDown);
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
			const groupServers = servers.filter(server => server.group === element.group);
			return groupServers.map((server, index) => new ServerTreeItem(
				server,
				!this.filter && index > 0,
				!this.filter && index < groupServers.length - 1,
			));
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
		const ungrouped = servers.filter(server => !server.group);
		const ungroupedServers = ungrouped.map((server, index) => new ServerTreeItem(
			server,
			!this.filter && index > 0,
			!this.filter && index < ungrouped.length - 1,
		));
		const groupEntries = [...groupedServers];
		const groups = groupEntries.map(([group, serverCount], index) => new ServerGroupTreeItem(
			group,
			serverCount,
			Boolean(this.filter),
			!this.filter && index > 0,
			!this.filter && index < groupEntries.length - 1,
		));
		return [...groups, ...ungroupedServers];
	}

	private matchesFilter(server: Server): boolean {
		if (!this.filter) {
			return true;
		}

		return serverSearchValues(server).some(value => value.toLocaleLowerCase().includes(this.filter));
	}

	dispose(): void {
		this.storeSubscription.dispose();
		this.changeEmitter.dispose();
	}
}

function treeItemContext(type: string, canMoveUp: boolean, canMoveDown: boolean): string {
	return [type, canMoveUp && 'moveUp', canMoveDown && 'moveDown'].filter(Boolean).join(':');
}

function serverDescription(server: Server): string {
	switch (server.type) {
		case 'container': return `${server.runtime} · ${server.executablePath}`;
		case 'mysql': return `${server.username}@${server.host}:${server.port}/${server.database}`;
		case 'ssh': return `${server.username}@${server.host}:${server.port}`;
	}
}

function serverSearchValues(server: Server): string[] {
	const common = [server.name, server.group, server.type];
	switch (server.type) {
		case 'container': return [...common, server.runtime, server.executablePath];
		case 'mysql': return [...common, server.host, server.port.toString(), server.username, server.database];
		case 'ssh': return [...common, server.host, server.port.toString(), server.username];
	}
}