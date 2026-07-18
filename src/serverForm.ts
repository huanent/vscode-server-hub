import * as vscode from 'vscode';
import { normalizePassword, parseServerForm, Server, ServerFormMessage, ServerType } from './server';
import { ServerStore } from './serverStore';
import { ServerTreeDataProvider } from './serverTree';

export function configureServerForm(
	context: vscode.ExtensionContext,
	panel: vscode.WebviewPanel,
	serverStore: ServerStore,
	treeDataProvider: ServerTreeDataProvider,
	serverType: ServerType,
	existingServer?: Server,
): void {
	const isEditing = existingServer !== undefined;
	const typeLabel = serverType === 'mysql' ? 'MySQL' : 'SSH';
	panel.title = `${isEditing ? 'Edit' : 'Add'} ${typeLabel} Server`;
	panel.webview.options = { enableScripts: true };

	panel.webview.html = renderServerForm(panel.webview, serverType, existingServer);
	panel.webview.onDidReceiveMessage(async (message: ServerFormMessage) => {
		if (message.type !== 'save') {
			return;
		}

		const server = parseServerForm(message, serverType, existingServer?.id);
		const password = normalizePassword(message.password);
		if (!server || (!isEditing && !password)) {
			void panel.webview.postMessage({ type: 'error', message: 'Please complete all required fields.' });
			return;
		}

		await serverStore.saveServer(server, password || undefined);
		treeDataProvider.refresh();
		panel.dispose();
		void vscode.window.showInformationMessage(`${isEditing ? 'Updated' : 'Saved'} ${typeLabel} server “${server.name}”.`);
	}, undefined, context.subscriptions);
}

function renderServerForm(webview: vscode.Webview, serverType: ServerType, server?: Server): string {
	const nonce = crypto.randomUUID().replaceAll('-', '');
	const isEditing = server !== undefined;
	const typeLabel = serverType === 'mysql' ? 'MySQL' : 'SSH';
	const title = `${isEditing ? 'Edit' : 'Add'} ${typeLabel} Server`;
	const defaultPort = serverType === 'mysql' ? 3306 : 22;
	const database = server?.type === 'mysql' ? server.database : '';
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<title>${title}</title>
	<style>
		body { max-width: 680px; margin: 0 auto; padding: 36px 28px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
		h1 { margin: 0 0 8px; font-size: 24px; font-weight: 600; }
		p { margin: 0 0 28px; color: var(--vscode-descriptionForeground); }
		form { display: grid; gap: 18px; }
		label { display: grid; gap: 7px; font-weight: 600; }
		.connection { display: grid; grid-template-columns: minmax(0, 1fr) 120px; gap: 14px; }
		input { box-sizing: border-box; width: 100%; padding: 8px 10px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); outline: none; }
		input:focus { border-color: var(--vscode-focusBorder); }
		button { justify-self: start; margin-top: 6px; padding: 8px 16px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; cursor: pointer; }
		button:hover { background: var(--vscode-button-hoverBackground); }
		#error { min-height: 18px; color: var(--vscode-errorForeground); font-weight: 400; }
		@media (max-width: 480px) { .connection { grid-template-columns: 1fr; } }
	</style>
</head>
<body>
	<h1>${title}</h1>
	<p>Connection details are stored on this device. The password remains encrypted.</p>
	<form id="server-form">
		<label>Name<input name="name" autocomplete="off" required autofocus placeholder="Production" value="${escapeHtml(server?.name ?? '')}"></label>
		<div class="connection">
			<label>Host<input name="host" autocomplete="off" required placeholder="server.example.com" value="${escapeHtml(server?.host ?? '')}"></label>
			<label>Port<input name="port" type="number" min="1" max="65535" value="${server?.port ?? defaultPort}" required></label>
		</div>
		<label>Username<input name="username" autocomplete="username" required placeholder="root" value="${escapeHtml(server?.username ?? '')}"></label>
		${serverType === 'mysql' ? `<label>Database<input name="database" autocomplete="off" required placeholder="app" value="${escapeHtml(database)}"></label>` : ''}
		<label>Password<input name="password" type="password" autocomplete="current-password" ${isEditing ? 'placeholder="Leave blank to keep the current password"' : 'required'}></label>
		<div id="error" role="alert"></div>
		<button type="submit">${isEditing ? 'Update Server' : 'Save Server'}</button>
	</form>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const form = document.getElementById('server-form');
		const error = document.getElementById('error');
		form.addEventListener('submit', event => {
			event.preventDefault();
			error.textContent = '';
			vscode.postMessage({ type: 'save', ...Object.fromEntries(new FormData(form)) });
		});
		window.addEventListener('message', event => {
			if (event.data.type === 'error') error.textContent = event.data.message;
		});
	</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('"', '&quot;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
}