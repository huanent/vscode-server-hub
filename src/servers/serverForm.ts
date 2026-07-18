import * as vscode from 'vscode';
import { normalizePassword, parseServerForm, Server, ServerFormMessage, ServerType } from './server';
import { ServerStore } from './serverStore';
import { createNonce, escapeHtml } from '../webview/webviewUtils';

export function configureServerForm(
	context: vscode.ExtensionContext,
	panel: vscode.WebviewPanel,
	serverStore: ServerStore,
	serverType: ServerType,
	existingServer?: Server,
): void {
	const isEditing = existingServer !== undefined;
	const typeLabel = serverType === 'mysql' ? 'MySQL' : 'SSH';
	panel.title = `${isEditing ? 'Edit' : 'Add'} ${typeLabel} Server`;
	panel.webview.options = { enableScripts: true };

	panel.webview.html = renderServerForm(
		panel.webview,
		serverType,
		serverStore.getGroups(),
		existingServer,
	);
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
		panel.dispose();
		void vscode.window.showInformationMessage(`${isEditing ? 'Updated' : 'Saved'} ${typeLabel} server “${server.name}”.`);
	}, undefined, context.subscriptions);
}

function renderServerForm(
	webview: vscode.Webview,
	serverType: ServerType,
	groups: string[],
	server?: Server,
): string {
	const nonce = createNonce();
	const isEditing = server !== undefined;
	const typeLabel = serverType === 'mysql' ? 'MySQL' : 'SSH';
	const title = `${isEditing ? 'Edit' : 'Add'} ${typeLabel} Server`;
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<title>${title}</title>
	<style>
		:root { color-scheme: light dark; }
		* { box-sizing: border-box; }
		body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
		form { min-height: 100vh; }
		.topbar { position: sticky; z-index: 2; top: 0; padding: 14px 22px; border-bottom: 1px solid var(--vscode-panel-border); background: color-mix(in srgb, var(--vscode-editor-background) 94%, transparent); backdrop-filter: blur(12px); }
		.topbar-content { display: grid; grid-template-columns: minmax(160px, 1.25fr) minmax(140px, 1fr) auto; align-items: end; gap: 12px; max-width: 820px; margin: 0 auto; }
		.field { display: grid; min-width: 0; gap: 5px; }
		.field-label { color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 700; letter-spacing: 0; text-transform: uppercase; }
		.required { color: var(--vscode-errorForeground); }
		input { width: 100%; min-height: 30px; padding: 5px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; outline: none; }
		input:hover { border-color: var(--vscode-dropdown-border, var(--vscode-input-border, transparent)); }
		input:focus { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
		.save-area { display: flex; align-items: center; min-height: 30px; }
		button { min-width: 76px; min-height: 30px; padding: 5px 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid transparent; border-radius: 3px; font: inherit; font-weight: 600; cursor: pointer; }
		button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
		button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
		button:disabled { color: var(--vscode-disabledForeground); background: var(--vscode-button-secondaryBackground); cursor: default; opacity: .65; }
		.content { width: min(640px, calc(100% - 44px)); margin: 0 auto; padding: 34px 0 56px; }
		.heading { margin-bottom: 24px; }
		h1 { margin: 0 0 6px; font-size: 22px; font-weight: 650; }
		.heading p { margin: 0; color: var(--vscode-descriptionForeground); line-height: 1.55; }
		.section { padding-top: 18px; border-top: 1px solid var(--vscode-panel-border); }
		.section-title { margin: 0 0 14px; font-size: 14px; font-weight: 650; }
		.fields { display: grid; gap: 14px; }
		.connection { display: grid; grid-template-columns: minmax(0, 1fr) 112px; gap: 12px; }
		#error { min-height: 20px; margin-top: 18px; color: var(--vscode-errorForeground); line-height: 1.45; }
		@media (max-width: 680px) {
			.topbar { padding: 12px 14px; }
			.topbar-content { grid-template-columns: minmax(0, 1fr) auto; }
			.topbar .group-field { grid-column: 1; grid-row: 2; }
			.save-area { grid-column: 2; grid-row: 1 / span 2; align-self: start; }
			.content { width: calc(100% - 28px); padding-top: 28px; }
		}
		@media (max-width: 440px) {
			.connection { grid-template-columns: 1fr; }
		}
	</style>
</head>
<body>
	<form id="server-form">
		${renderFormTopbar(groups, server, isEditing)}
		<main class="content">
			<header class="heading">
				<h1>${title}</h1>
				<p>Configure the ${typeLabel} connection. Credentials remain encrypted on this device.</p>
			</header>
			<section class="section" aria-labelledby="connection-heading">
				<h2 class="section-title" id="connection-heading">Connection details</h2>
				<div class="fields">${renderServerFields(serverType, server, isEditing)}</div>
			</section>
			<div id="error" role="alert"></div>
		</main>
	</form>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const form = document.getElementById('server-form');
		const error = document.getElementById('error');
		const saveButton = document.getElementById('save-button');
		const updateSaveState = () => {
			saveButton.disabled = !form.checkValidity();
		};
		form.addEventListener('input', updateSaveState);
		form.addEventListener('change', updateSaveState);
		updateSaveState();
		form.addEventListener('submit', event => {
			event.preventDefault();
			if (saveButton.disabled) return;
			error.textContent = '';
			saveButton.disabled = true;
			vscode.postMessage({ type: 'save', ...Object.fromEntries(new FormData(form)) });
		});
		window.addEventListener('message', event => {
			if (event.data.type === 'error') {
				error.textContent = event.data.message;
				updateSaveState();
			}
		});
	</script>
</body>
</html>`;
}

function renderFormTopbar(groups: string[], server: Server | undefined, isEditing: boolean): string {
	return `<header class="topbar">
		<div class="topbar-content">
			<label class="field">
				<span class="field-label">Name <span class="required" aria-hidden="true">*</span></span>
				<input name="name" autocomplete="off" required autofocus placeholder="Production" value="${escapeHtml(server?.name ?? '')}">
			</label>
			<label class="field group-field">
				<span class="field-label">Group</span>
				<input name="group" list="server-groups" autocomplete="off" placeholder="No group" value="${escapeHtml(server?.group ?? '')}">
			</label>
			<datalist id="server-groups">${groups.map(group => `<option value="${escapeHtml(group)}"></option>`).join('')}</datalist>
			<div class="save-area">
				<button id="save-button" type="submit" disabled>Save</button>
			</div>
		</div>
	</header>`;
}

function renderServerFields(serverType: ServerType, server: Server | undefined, isEditing: boolean): string {
	const defaultPort = serverType === 'mysql' ? 3306 : 22;
	const database = server?.type === 'mysql' ? server.database : '';
	return `<div class="connection">
		<label class="field">
			<span class="field-label">Host <span class="required" aria-hidden="true">*</span></span>
			<input name="host" autocomplete="off" required placeholder="server.example.com" value="${escapeHtml(server?.host ?? '')}">
		</label>
		<label class="field">
			<span class="field-label">Port <span class="required" aria-hidden="true">*</span></span>
			<input name="port" type="number" min="1" max="65535" value="${server?.port ?? defaultPort}" required>
		</label>
	</div>
	<label class="field">
		<span class="field-label">Username <span class="required" aria-hidden="true">*</span></span>
		<input name="username" autocomplete="username" required placeholder="root" value="${escapeHtml(server?.username ?? '')}">
	</label>
	${serverType === 'mysql' ? `<label class="field">
		<span class="field-label">Database <span class="required" aria-hidden="true">*</span></span>
		<input name="database" autocomplete="off" required placeholder="app" value="${escapeHtml(database)}">
	</label>` : ''}
	<label class="field">
		<span class="field-label">Password${isEditing ? '' : ' <span class="required" aria-hidden="true">*</span>'}</span>
		<input name="password" type="password" autocomplete="current-password" ${isEditing ? 'placeholder="Leave blank to keep the current password"' : 'required'}>
	</label>`;
}
