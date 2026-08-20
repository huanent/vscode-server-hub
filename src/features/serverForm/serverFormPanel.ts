import * as vscode from 'vscode';
import { normalizePassword, parseServerForm, Server, ServerFormMessage, ServerType, SshServer, usesPrivateKey } from '../../servers/server';
import { ServerCredentials, ServerStore } from '../../servers/serverStore';
import { getWebviewHtml } from '../../webview';

type ServerFormWebviewMessage = ServerFormMessage | { type: 'ready' };

export async function configureServerForm(
	context: vscode.ExtensionContext,
	panel: vscode.WebviewPanel,
	serverStore: ServerStore,
	serverType: ServerType,
	existingServer?: Server,
): Promise<void> {
	const isEditing = existingServer !== undefined;
	const typeLabel = serverType === 'mysql' ? 'MySQL' : serverType === 'container' ? 'Container' : 'SSH';
	const title = `${isEditing ? 'Edit' : 'Add'} ${typeLabel} Server`;
	const credentials = existingServer ? await serverStore.getCredentials(existingServer.id) : {};
	const sshServers = serverStore.getServers().filter((server): server is SshServer => server.type === 'ssh');

	panel.title = title;
	panel.webview.options = {
		enableScripts: true,
		localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
	};
	panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri, 'serverForm', title);
	panel.webview.onDidReceiveMessage(
		(message: ServerFormWebviewMessage) => handleMessage(
			message,
			context,
			panel,
			serverStore,
			serverType,
			existingServer,
			credentials,
			sshServers,
		),
		undefined,
		context.subscriptions,
	);
}

async function handleMessage(
	message: ServerFormWebviewMessage,
	context: vscode.ExtensionContext,
	panel: vscode.WebviewPanel,
	serverStore: ServerStore,
	serverType: ServerType,
	existingServer: Server | undefined,
	credentials: ServerCredentials,
	sshServers: SshServer[],
): Promise<void> {
	if (message.type === 'ready') {
		await panel.webview.postMessage({
			type: 'initialize',
			model: {
				serverType,
				server: existingServer,
				credentials,
				groups: serverStore.getGroups(),
				sshServers,
			},
		});
		return;
	}
	if (message.type === 'selectExecutable') {
		await selectFile(panel, 'Select Container Executable', 'executableSelected');
		return;
	}
	if (message.type === 'selectPrivateKey' || message.type === 'selectProxyPrivateKey') {
		const selection = await vscode.window.showOpenDialog({
			canSelectMany: false,
			canSelectFiles: true,
			canSelectFolders: false,
			openLabel: 'Select',
			title: 'Select SSH Private Key',
		});
		if (!selection?.[0]) {
			return;
		}
		try {
			const contents = await vscode.workspace.fs.readFile(selection[0]);
			await panel.webview.postMessage({ type: message.type === 'selectProxyPrivateKey' ? 'proxyPrivateKeySelected' : 'privateKeySelected', contents: Buffer.from(contents).toString('utf8') });
		} catch (error) {
			await panel.webview.postMessage({ type: 'error', message: `Could not read the private key: ${error instanceof Error ? error.message : String(error)}` });
		}
		return;
	}

	const server = parseServerForm(message, serverType, existingServer?.id);
	const nextCredentials = {
		password: normalizePassword(message.password),
		privateKey: normalizePassword(message.privateKey),
		passphrase: normalizePassword(message.passphrase),
		proxyPassword: normalizePassword(message.proxyPassword),
		proxyPrivateKey: normalizePassword(message.proxyPrivateKey),
		proxyPassphrase: normalizePassword(message.proxyPassphrase),
	};
	const usesOwnCredentials = server?.type === 'ssh'
		|| server?.type === 'mysql'
		|| server?.type === 'container' && server.connectionType === 'ssh' && !server.sshServerId;
	const existingUsesOwnCredentials = existingServer?.type === 'ssh'
		|| existingServer?.type === 'mysql'
		|| existingServer?.type === 'container' && existingServer.connectionType === 'ssh' && !existingServer.sshServerId;
	const credentialsChanged = usesOwnCredentials
		&& (!existingUsesOwnCredentials || existingServer === undefined || usesPrivateKey(server) !== usesPrivateKey(existingServer));
	const requiresCredential = usesOwnCredentials && (!existingServer || credentialsChanged);
	const hasCredential = server && usesPrivateKey(server) ? Boolean(nextCredentials.privateKey) : Boolean(nextCredentials.password);
	const nextProxy = server && 'proxy' in server ? server.proxy : undefined;
	const proxyCredentialRequired = Boolean(nextProxy)
		&& (!existingServer
			|| !('proxy' in existingServer)
			|| !existingServer.proxy
			|| existingServer.proxy.authType !== nextProxy?.authType);
	const hasProxyCredential = nextProxy?.authType === 'privateKey'
		? Boolean(nextCredentials.proxyPrivateKey)
		: Boolean(nextCredentials.proxyPassword);
	if (!server || (requiresCredential && !hasCredential) || (proxyCredentialRequired && !hasProxyCredential)) {
		await panel.webview.postMessage({ type: 'error', message: 'Please complete all required fields.' });
		return;
	}

	await serverStore.saveServer(server, nextCredentials);
	panel.dispose();
}

async function selectFile(panel: vscode.WebviewPanel, title: string, type: string): Promise<void> {
	const selection = await vscode.window.showOpenDialog({
		canSelectMany: false,
		canSelectFiles: true,
		canSelectFolders: false,
		openLabel: 'Select',
		title,
	});
	if (selection?.[0]) {
		await panel.webview.postMessage({ type, path: selection[0].fsPath });
	}
}