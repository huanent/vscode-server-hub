import * as vscode from 'vscode';
import { configureMysqlEditor, configureMysqlTablePreview } from './mysqlEditor';
import { MysqlServer, Server, ServerType } from './server';
import { configureServerForm } from './serverForm';
import { ServerStore } from './serverStore';
import { ServerTreeDataProvider } from './serverTree';
import { configureSshTerminal } from './sshTerminal';

const editorViewType = 'server-hub.editor';

type EditorKind = 'serverForm' | 'sshTerminal' | 'mysqlEditor' | 'mysqlTablePreview';

interface EditorDescriptor {
	kind: EditorKind;
	serverId?: string;
	serverType?: ServerType;
	database?: string;
	table?: string;
}

class ServerHubDocument implements vscode.CustomDocument {
	constructor(readonly uri: vscode.Uri, readonly descriptor: EditorDescriptor) {}
	dispose(): void {}
}

export function registerServerHubEditor(
	context: vscode.ExtensionContext,
	serverStore: ServerStore,
	treeDataProvider: ServerTreeDataProvider,
): vscode.Disposable {
	const provider: vscode.CustomReadonlyEditorProvider<ServerHubDocument> = {
		openCustomDocument: uri => new ServerHubDocument(uri, parseDescriptor(uri)),
		resolveCustomEditor: async (document, panel) => {
			const { descriptor } = document;
			if (descriptor.kind === 'serverForm') {
				const server = descriptor.serverId ? findServer(serverStore, descriptor.serverId) : undefined;
				const serverType = server?.type ?? descriptor.serverType;
				if (!serverType) {
					throw new Error('The server form does not specify a server type.');
				}
				configureServerForm(context, panel, serverStore, treeDataProvider, serverType, server);
				return;
			}

			const server = findServer(serverStore, descriptor.serverId);
			const password = await serverStore.getPassword(server.id);
			if (!password) {
				throw new Error(`No password is available for “${server.name}” on this device.`);
			}

			if (descriptor.kind === 'sshTerminal' && server.type === 'ssh') {
				configureSshTerminal(context.extensionUri, panel, server, password);
				return;
			}
			if (descriptor.kind === 'mysqlEditor' && server.type === 'mysql') {
				configureMysqlEditor(context.extensionUri, panel, server, password, (database, table) => {
					void openMysqlTablePreview(server, database, table);
				});
				return;
			}
			if (
				descriptor.kind === 'mysqlTablePreview'
				&& server.type === 'mysql'
				&& descriptor.database
				&& descriptor.table
			) {
				configureMysqlTablePreview(
					context.extensionUri,
					panel,
					server,
					password,
					descriptor.database,
					descriptor.table,
				);
				return;
			}
			throw new Error('The Server Hub editor resource is invalid.');
		},
	};

	return vscode.window.registerCustomEditorProvider(editorViewType, provider, {
		supportsMultipleEditorsPerDocument: true,
		webviewOptions: { retainContextWhenHidden: true },
	});
}

export function openServerForm(serverType: ServerType, server?: Server): Thenable<unknown> {
	return openEditor({ kind: 'serverForm', serverType, serverId: server?.id });
}

export function openServerConnection(server: Server): Thenable<unknown> {
	return openEditor({
		kind: server.type === 'ssh' ? 'sshTerminal' : 'mysqlEditor',
		serverId: server.id,
	});
}

function openMysqlTablePreview(server: MysqlServer, database: string, table: string): Thenable<unknown> {
	return openEditor({ kind: 'mysqlTablePreview', serverId: server.id, database, table });
}

function openEditor(descriptor: EditorDescriptor): Thenable<unknown> {
	const params = new URLSearchParams({ kind: descriptor.kind, id: crypto.randomUUID() });
	if (descriptor.serverId) params.set('serverId', descriptor.serverId);
	if (descriptor.serverType) params.set('serverType', descriptor.serverType);
	if (descriptor.database) params.set('database', descriptor.database);
	if (descriptor.table) params.set('table', descriptor.table);
	const resource = vscode.Uri.from({
		scheme: 'server-hub',
		path: `/${descriptor.kind}.server-hub`,
		query: params.toString(),
	});
	return vscode.commands.executeCommand('vscode.openWith', resource, editorViewType, {
		preview: false,
		viewColumn: vscode.ViewColumn.Active,
	});
}

function parseDescriptor(uri: vscode.Uri): EditorDescriptor {
	const params = new URLSearchParams(uri.query);
	const kind = params.get('kind');
	if (kind !== 'serverForm' && kind !== 'sshTerminal' && kind !== 'mysqlEditor' && kind !== 'mysqlTablePreview') {
		throw new Error('The Server Hub editor resource has an unknown type.');
	}
	const serverType = params.get('serverType');
	return {
		kind,
		serverId: params.get('serverId') ?? undefined,
		serverType: serverType === 'ssh' || serverType === 'mysql' ? serverType : undefined,
		database: params.get('database') ?? undefined,
		table: params.get('table') ?? undefined,
	};
}

function findServer(serverStore: ServerStore, serverId?: string): Server {
	const server = serverId ? serverStore.getServers().find(candidate => candidate.id === serverId) : undefined;
	if (!server) {
		throw new Error('The server no longer exists.');
	}
	return server;
}