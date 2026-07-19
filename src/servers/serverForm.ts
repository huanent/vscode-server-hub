import * as vscode from 'vscode';
import { normalizePassword, parseServerForm, Server, ServerFormMessage, ServerType } from './server';
import { ServerCredentials, ServerStore } from './serverStore';
import { codiconsDistUri, createNonce, escapeHtml } from '../webview/webviewUtils';

export async function configureServerForm(
	context: vscode.ExtensionContext,
	panel: vscode.WebviewPanel,
	serverStore: ServerStore,
	serverType: ServerType,
	existingServer?: Server,
): Promise<void> {
	const isEditing = existingServer !== undefined;
	const typeLabel = serverType === 'mysql' ? 'MySQL' : 'SSH';
	panel.title = `${isEditing ? 'Edit' : 'Add'} ${typeLabel} Server`;
	panel.webview.options = {
		enableScripts: true,
		localResourceRoots: [codiconsDistUri(context.extensionUri)],
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
		if (message.type === 'selectPrivateKey') {
			const selection = await vscode.window.showOpenDialog({
				canSelectMany: false,
				canSelectFiles: true,
				canSelectFolders: false,
				openLabel: 'Select Private Key',
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
		const requiresCredential = !isEditing || authChanged;
		const hasCredential = server?.type === 'ssh' && server.authType === 'privateKey'
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
	const isEditing = server !== undefined;
	const typeLabel = serverType === 'mysql' ? 'MySQL' : 'SSH';
	const title = `${isEditing ? 'Edit' : 'Add'} ${typeLabel} Server`;
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<link rel="stylesheet" href="${codiconsUri}">
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
		input, select, textarea { width: 100%; min-height: 30px; padding: 5px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; outline: none; font: inherit; }
		.group-control { position: relative; display: block; }
		.group-options { position: absolute; z-index: 3; top: calc(100% + 3px); left: 0; right: 0; display: block; max-height: 180px; overflow-y: auto; padding: 3px; background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); box-shadow: 0 4px 12px var(--vscode-widget-shadow); }
		.group-option { display: block; width: 100%; padding: 5px 7px; color: var(--vscode-dropdown-foreground); cursor: pointer; }
		.group-option[aria-selected="true"] { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
		textarea { min-height: 140px; resize: vertical; font-family: var(--vscode-editor-font-family); }
		input:hover, select:hover, textarea:hover { border-color: var(--vscode-dropdown-border, var(--vscode-input-border, transparent)); }
		input:focus, select:focus, textarea:focus { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
		.password-control { position: relative; }
		.password-control input { padding-right: 34px; }
		.password-toggle { position: absolute; top: 0; right: 0; display: grid; place-items: center; width: 30px; min-width: 30px; height: 30px; min-height: 30px; padding: 0; color: var(--vscode-input-foreground); background: transparent; border: 0; border-radius: 0; opacity: .8; }
		.password-toggle:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
		.auth-tabs { display: inline-flex; justify-self: start; gap: 1px; padding: 2px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
		.auth-tab { min-width: auto; min-height: 26px; padding: 3px 10px; color: var(--vscode-foreground); background: transparent; font-size: 12px; font-weight: 500; }
		.auth-tab:hover { background: var(--vscode-toolbar-hoverBackground); }
		.auth-tab[aria-selected="true"] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
		.auth-tab[aria-selected="true"]:hover { background: var(--vscode-button-hoverBackground); }
		.field-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
		.file-select { display: inline-flex; align-items: center; gap: 5px; min-width: auto; min-height: 24px; padding: 2px 7px; color: var(--vscode-foreground); background: transparent; font-size: 11px; font-weight: 500; }
		.file-select:hover { background: var(--vscode-toolbar-hoverBackground); }
		[hidden] { display: none !important; }
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
				<div class="fields">${renderServerFields(serverType, server, isEditing, credentials)}</div>
			</section>
			<div id="error" role="alert"></div>
		</main>
	</form>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const form = document.getElementById('server-form');
		const error = document.getElementById('error');
		const saveButton = document.getElementById('save-button');
		const authType = form.elements.namedItem('authType');
		const passwordField = document.getElementById('password-field');
		const privateKeyFields = document.getElementById('private-key-fields');
		const passwordInput = form.elements.namedItem('password');
		const privateKeyInput = form.elements.namedItem('privateKey');
		const selectPrivateKeyButton = document.getElementById('select-private-key');
		const groupInput = form.elements.namedItem('group');
		const groupOptions = document.getElementById('group-options');
		const isEditing = ${JSON.stringify(isEditing)};
		const initialAuthType = ${JSON.stringify(server?.type === 'ssh' ? server.authType : 'password')};
		let highlightedGroup = -1;
		const visibleGroupOptions = () => [...groupOptions.querySelectorAll('.group-option:not([hidden])')];
		const closeGroupOptions = () => {
			groupOptions.hidden = true;
			groupInput.setAttribute('aria-expanded', 'false');
			groupInput.removeAttribute('aria-activedescendant');
			highlightedGroup = -1;
		};
		const highlightGroup = index => {
			const options = visibleGroupOptions();
			if (!options.length) return;
			highlightedGroup = (index + options.length) % options.length;
			for (const [optionIndex, option] of options.entries()) {
				option.setAttribute('aria-selected', String(optionIndex === highlightedGroup));
			}
			const option = options[highlightedGroup];
			groupInput.setAttribute('aria-activedescendant', option.id);
			option.scrollIntoView({ block: 'nearest' });
		};
		const openGroupOptions = () => {
			const query = groupInput.value.trim().toLocaleLowerCase();
			for (const option of groupOptions.querySelectorAll('.group-option')) {
				option.hidden = query !== '' && !option.dataset.value.toLocaleLowerCase().includes(query);
				option.setAttribute('aria-selected', 'false');
			}
			const hasOptions = visibleGroupOptions().length > 0;
			groupOptions.hidden = !hasOptions;
			groupInput.setAttribute('aria-expanded', String(hasOptions));
			groupInput.removeAttribute('aria-activedescendant');
			highlightedGroup = -1;
		};
		const selectGroup = option => {
			groupInput.value = option.dataset.value;
			closeGroupOptions();
			groupInput.dispatchEvent(new Event('input', { bubbles: true }));
		};
		groupInput.addEventListener('focus', openGroupOptions);
		groupInput.addEventListener('input', openGroupOptions);
		groupInput.addEventListener('keydown', event => {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				if (groupOptions.hidden) openGroupOptions();
				const offset = event.key === 'ArrowDown' ? 1 : -1;
				highlightGroup(highlightedGroup < 0 && offset < 0 ? visibleGroupOptions().length - 1 : highlightedGroup + offset);
				return;
			}
			if (event.key === 'Enter' && highlightedGroup >= 0) {
				event.preventDefault();
				selectGroup(visibleGroupOptions()[highlightedGroup]);
				return;
			}
			if (event.key === 'Escape') closeGroupOptions();
		});
		groupInput.addEventListener('blur', () => setTimeout(closeGroupOptions));
		for (const option of groupOptions.querySelectorAll('.group-option')) {
			option.addEventListener('mousedown', event => {
				event.preventDefault();
				selectGroup(option);
			});
		}
		for (const tab of document.querySelectorAll('.auth-tab')) {
			tab.addEventListener('click', () => {
				authType.value = tab.dataset.authType;
				for (const candidate of document.querySelectorAll('.auth-tab')) {
					candidate.setAttribute('aria-selected', String(candidate === tab));
					candidate.tabIndex = candidate === tab ? 0 : -1;
				}
				updateSaveState();
			});
		}
		for (const toggle of document.querySelectorAll('.password-toggle')) {
			toggle.addEventListener('click', () => {
				const input = document.getElementById(toggle.dataset.target);
				const visible = input.type === 'text';
				input.type = visible ? 'password' : 'text';
				toggle.classList.toggle('codicon-eye', visible);
				toggle.classList.toggle('codicon-eye-closed', !visible);
				toggle.title = visible ? 'Show value' : 'Hide value';
				toggle.setAttribute('aria-label', toggle.title);
			});
		}
		selectPrivateKeyButton?.addEventListener('click', () => {
			error.textContent = '';
			vscode.postMessage({ type: 'selectPrivateKey' });
		});
		const updateAuthFields = () => {
			if (!authType) return;
			const usesPrivateKey = authType.value === 'privateKey';
			const authChanged = authType.value !== initialAuthType;
			passwordField.hidden = usesPrivateKey;
			privateKeyFields.hidden = !usesPrivateKey;
			passwordInput.required = (!isEditing || authChanged) && !usesPrivateKey;
			privateKeyInput.required = (!isEditing || authChanged) && usesPrivateKey;
		};
		const updateSaveState = () => {
			updateAuthFields();
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
			if (event.data.type === 'privateKeySelected' && typeof event.data.contents === 'string') {
				privateKeyInput.value = event.data.contents;
				updateSaveState();
				privateKeyInput.focus();
				return;
			}
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
				<span class="group-control">
					<input name="group" role="combobox" aria-autocomplete="list" aria-controls="group-options" aria-expanded="false" autocomplete="off" placeholder="No group" value="${escapeHtml(server?.group ?? '')}">
					<span id="group-options" class="group-options" role="listbox" hidden>${groups.map((group, index) => `<span id="group-option-${index}" class="group-option" role="option" aria-selected="false" data-value="${escapeHtml(group)}">${escapeHtml(group)}</span>`).join('')}</span>
				</span>
			</label>
			<div class="save-area">
				<button id="save-button" type="submit" disabled>Save</button>
			</div>
		</div>
	</header>`;
}

function renderServerFields(
	serverType: ServerType,
	server: Server | undefined,
	isEditing: boolean,
	credentials: ServerCredentials,
): string {
	const defaultPort = serverType === 'mysql' ? 3306 : 22;
	const database = server?.type === 'mysql' ? server.database : '';
	const authType = server?.type === 'ssh' ? server.authType : 'password';
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
	</label>` : `<div class="field">
		<input name="authType" type="hidden" value="${authType}">
		<div class="auth-tabs" role="tablist" aria-label="Authentication method">
			<button class="auth-tab" type="button" role="tab" data-auth-type="password" aria-selected="${authType === 'password'}" tabindex="${authType === 'password' ? '0' : '-1'}">Password</button>
			<button class="auth-tab" type="button" role="tab" data-auth-type="privateKey" aria-selected="${authType === 'privateKey'}" tabindex="${authType === 'privateKey' ? '0' : '-1'}">Private key</button>
		</div>
	</div>`}
	<label class="field" id="password-field">
		<span class="field-label">Password${isEditing ? '' : ' <span class="required" aria-hidden="true">*</span>'}</span>
		<span class="password-control">
			<input id="password" name="password" type="password" autocomplete="current-password" value="${escapeHtml(credentials.password ?? '')}" required>
			<button class="password-toggle codicon codicon-eye" type="button" data-target="password" title="Show value" aria-label="Show value"></button>
		</span>
	</label>
	${serverType === 'ssh' ? `<div class="fields" id="private-key-fields" hidden>
		<label class="field">
			<span class="field-heading">
				<span class="field-label">Private key <span class="required" aria-hidden="true">*</span></span>
				<button id="select-private-key" class="file-select" type="button"><span class="codicon codicon-folder-opened" aria-hidden="true"></span>Select file</button>
			</span>
			<textarea name="privateKey" spellcheck="false" placeholder="Paste the PEM or OpenSSH private key">${escapeHtml(credentials.privateKey ?? '')}</textarea>
		</label>
		<label class="field">
			<span class="field-label">Key passphrase</span>
			<span class="password-control">
				<input id="passphrase" name="passphrase" type="password" autocomplete="off" value="${escapeHtml(credentials.passphrase ?? '')}" placeholder="Optional">
				<button class="password-toggle codicon codicon-eye" type="button" data-target="passphrase" title="Show value" aria-label="Show value"></button>
			</span>
		</label>
	</div>` : ''}`;
}
