import * as vscode from 'vscode';
import { normalizePassword, parseServerForm, Server, ServerFormMessage, ServerType } from './server';
import { ServerCredentials, ServerStore } from './serverStore';
import { codiconsDistUri, createNonce } from '../utils';

export async function configureServerForm(
	context: vscode.ExtensionContext,
	panel: vscode.WebviewPanel,
	serverStore: ServerStore,
	serverType: ServerType,
	existingServer?: Server,
): Promise<void> {
	const isEditing = existingServer !== undefined;
	const typeLabel = serverType === 'mysql' ? 'MySQL' : serverType === 'container' ? 'Container' : 'SSH';
	panel.title = `${isEditing ? 'Edit' : 'Add'} ${typeLabel} Server`;
	panel.webview.options = {
		enableScripts: true,
		localResourceRoots: [
			codiconsDistUri(context.extensionUri),
			vscode.Uri.joinPath(context.extensionUri, 'resources', 'webview'),
		],
	};
	const credentials = existingServer
		? await serverStore.getCredentials(existingServer.id)
		: {};

	panel.webview.html = renderServerForm(
		panel.webview,
		context.extensionUri,
		serverType,
		serverStore.getGroups(),
		existingServer,
		credentials,
	);
	panel.webview.onDidReceiveMessage(async (message: ServerFormMessage) => {
		if (message.type === 'selectExecutable') {
			const selection = await vscode.window.showOpenDialog({
				canSelectMany: false,
				canSelectFiles: true,
				canSelectFolders: false,
				openLabel: 'Select',
				title: 'Select Container Executable',
			});
			if (selection?.[0]) {
				void panel.webview.postMessage({ type: 'executableSelected', path: selection[0].fsPath });
			}
			return;
		}
		if (message.type === 'selectPrivateKey') {
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
				void panel.webview.postMessage({
					type: 'privateKeySelected',
					contents: Buffer.from(contents).toString('utf8'),
				});
			} catch (error) {
				void panel.webview.postMessage({
					type: 'error',
					message: `Could not read the private key: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
			return;
		}
		if (message.type !== 'save') {
			return;
		}

		const server = parseServerForm(message, serverType, existingServer?.id);
		const credentials = {
			password: normalizePassword(message.password),
			privateKey: normalizePassword(message.privateKey),
			passphrase: normalizePassword(message.passphrase),
		};
		const authChanged = server?.type === 'ssh'
			&& existingServer?.type === 'ssh'
			&& server.authType !== existingServer.authType;
		const requiresCredential = server?.type !== 'container' && (!isEditing || authChanged);
		const hasCredential = server?.type === 'container' ? true : server?.type === 'ssh' && server.authType === 'privateKey'
			? Boolean(credentials.privateKey)
			: Boolean(credentials.password);
		if (!server || (requiresCredential && !hasCredential)) {
			void panel.webview.postMessage({ type: 'error', message: 'Please complete all required fields.' });
			return;
		}

		await serverStore.saveServer(server, credentials);
		panel.dispose();
	}, undefined, context.subscriptions);
}

function renderServerForm(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	serverType: ServerType,
	groups: string[],
	server?: Server,
	credentials: ServerCredentials = {},
): string {
	const nonce = createNonce();
	const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(codiconsDistUri(extensionUri), 'codicon.css'));
	const webviewRoot = vscode.Uri.joinPath(extensionUri, 'resources', 'webview');
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'server-form.js'));
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewRoot, 'server-form.css'));
	const isEditing = server !== undefined;
	const typeLabel = serverType === 'mysql' ? 'MySQL' : serverType === 'container' ? 'Container' : 'SSH';
	const title = `${isEditing ? 'Edit' : 'Add'} ${typeLabel} Server`;
	const initialData = serializeForHtml({
		serverType,
		groups,
		server,
		credentials,
		isEditing,
		title,
		description: serverType === 'container'
			? 'Configure Docker, Podman, or Apple Container on this device.'
			: `Configure the ${typeLabel} connection. Credentials remain encrypted on this device.`,
	});
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<link rel="stylesheet" href="${codiconsUri}">
	<link rel="stylesheet" href="${styleUri}">
	<title>${title}</title>
</head>
<body>
	<div id="root"></div>
	<script id="server-form-data" type="application/json" nonce="${nonce}">${initialData}</script>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function serializeForHtml(value: unknown): string {
	return JSON.stringify(value)
		.replaceAll('&', '\\u0026')
		.replaceAll('<', '\\u003c')
		.replaceAll('>', '\\u003e')
		.replaceAll('\u2028', '\\u2028')
		.replaceAll('\u2029', '\\u2029');
}
