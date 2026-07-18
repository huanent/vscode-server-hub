import * as vscode from 'vscode';
import { configureMysqlEditor, configureMysqlTablePreview } from './mysql/mysqlEditor';
import { MysqlServer, Server, ServerType } from './servers/server';
import { configureServerForm } from './servers/serverForm';
import { ServerStore } from './servers/serverStore';
import { configureSshTerminal } from './ssh/sshTerminal';
import {
	createEditorUri,
	EditorDescriptor,
	parseEditorDescriptor,
	serverHubEditorViewType,
} from './editors/editorDescriptor';

class ServerHubDocument implements vscode.CustomDocument {
	constructor(readonly uri: vscode.Uri, readonly descriptor: EditorDescriptor) {}
	dispose(): void {}
}

export function registerServerHubEditor(
	context: vscode.ExtensionContext,
	serverStore: ServerStore,
): vscode.Disposable {
	const provider: vscode.CustomReadonlyEditorProvider<ServerHubDocument> = {
		openCustomDocument: uri => new ServerHubDocument(uri, parseEditorDescriptor(uri)),
		resolveCustomEditor: async (document, panel) => {
			const { descriptor } = document;
			if (descriptor.kind === 'serverForm') {
				const server = descriptor.serverId ? findServer(serverStore, descriptor.serverId) : undefined;
				const serverType = server?.type ?? descriptor.serverType;
				if (!serverType) {
					throw new Error('The server form does not specify a server type.');
				}
				await configureServerForm(context, panel, serverStore, serverType, server);
				return;
			}

			const server = findServer(serverStore, descriptor.serverId);
			if (descriptor.kind === 'sshTerminal' && server.type === 'ssh') {
				const credentials = await serverStore.getCredentials(server.id);
				if (server.authType === 'privateKey' ? !credentials.privateKey : !credentials.password) {
					throw new Error(`No ${server.authType === 'privateKey' ? 'private key' : 'password'} is available for “${server.name}” on this device.`);
				}
				configureSshTerminal(context.extensionUri, panel, server, credentials);
				return;
			}
			const password = await serverStore.getPassword(server.id);
			if (!password) {
				throw new Error(`No password is available for “${server.name}” on this device.`);
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

	return vscode.window.registerCustomEditorProvider(serverHubEditorViewType, provider, {
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
	return vscode.commands.executeCommand('vscode.openWith', createEditorUri(descriptor), serverHubEditorViewType, {
		preview: false,
		viewColumn: vscode.ViewColumn.Active,
	});
}

function findServer(serverStore: ServerStore, serverId?: string): Server {
	const server = serverId ? serverStore.getServers().find(candidate => candidate.id === serverId) : undefined;
	if (!server) {
		throw new Error('The server no longer exists.');
	}
	return server;
}