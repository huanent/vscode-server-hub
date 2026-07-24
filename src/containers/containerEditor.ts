import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { ContainerServer } from '../servers/server';
import { codiconsDistUri, createNonce, escapeHtml } from '../utils';

const execFileAsync = promisify(execFile);

type ResourceType = 'containers' | 'images' | 'volumes' | 'networks';

interface ContainerEditorMessage {
	type: 'load' | 'inspect' | 'systemAction' | 'containerAction';
	resource?: unknown;
	id?: unknown;
	action?: unknown;
}

type ServiceState = 'checking' | 'running' | 'stopped' | 'error';

interface ResourceRow {
	id: string;
	name: string;
	status: string;
	detail: string;
	size: string;
}

export function configureContainerEditor(
	extensionUri: vscode.Uri,
	panel: vscode.WebviewPanel,
	server: ContainerServer,
): void {
	panel.title = server.name;
	panel.iconPath = new vscode.ThemeIcon('server-process');
	panel.webview.options = {
		enableScripts: true,
		localResourceRoots: [codiconsDistUri(extensionUri)],
	};
	panel.webview.html = renderContainerEditor(panel.webview, extensionUri, server);

	panel.webview.onDidReceiveMessage(async (message: ContainerEditorMessage) => {
		if (message.type === 'load' && isResourceType(message.resource)) {
			await loadResource(message.resource);
			return;
		}
		if (message.type === 'systemAction'
			&& server.runtime === 'apple'
			&& (message.action === 'start' || message.action === 'stop')) {
			await changeAppleSystemState(message.action);
			return;
		}
		if (message.type === 'containerAction'
			&& typeof message.id === 'string'
			&& (message.action === 'start' || message.action === 'stop')) {
			await changeContainerState(message.id, message.action);
			return;
		}
		if (message.type === 'inspect' && isResourceType(message.resource) && typeof message.id === 'string') {
			await inspectResource(message.resource, message.id);
		}
	});

	void refreshServiceStatus();
	void loadResource('containers');

	async function refreshServiceStatus(): Promise<void> {
		void panel.webview.postMessage({ type: 'serviceStatus', state: 'checking' satisfies ServiceState });
		try {
			const state = await readServiceState(server);
			void panel.webview.postMessage({ type: 'serviceStatus', state });
		} catch (error) {
			void panel.webview.postMessage({ type: 'serviceStatus', state: 'error' satisfies ServiceState, message: errorMessage(error) });
		}
	}

	async function changeAppleSystemState(action: 'start' | 'stop'): Promise<void> {
		void panel.webview.postMessage({ type: 'systemActionPending', action });
		try {
			await executeContainerCommand(server, action === 'start'
				? ['system', 'start', '--disable-kernel-install']
				: ['system', 'stop']);
			await refreshServiceStatus();
			if (action === 'start') {
				await loadResource('containers');
			}
		} catch (error) {
			void panel.webview.postMessage({
				type: 'serviceStatus',
				state: 'error' satisfies ServiceState,
				message: errorMessage(error),
			});
		} finally {
			void panel.webview.postMessage({ type: 'systemActionComplete' });
		}
	}

	async function loadResource(resource: ResourceType): Promise<void> {
		void panel.webview.postMessage({ type: 'loading', resource });
		try {
			const rows = await listResource(server, resource);
			void panel.webview.postMessage({ type: 'resource', resource, rows });
		} catch (error) {
			void panel.webview.postMessage({ type: 'error', resource, message: errorMessage(error) });
		}
	}

	async function changeContainerState(id: string, action: 'start' | 'stop'): Promise<void> {
		void panel.webview.postMessage({ type: 'containerActionPending', id, action });
		try {
			await executeContainerCommand(server, [action, id]);
			await loadResource('containers');
		} catch (error) {
			void panel.webview.postMessage({ type: 'containerActionError', id, message: errorMessage(error) });
		} finally {
			void panel.webview.postMessage({ type: 'containerActionComplete', id });
		}
	}

	async function inspectResource(resource: ResourceType, id: string): Promise<void> {
		try {
			const details = await inspectResourceDetails(server, resource, id);
			void panel.webview.postMessage({ type: 'details', resource, id, details });
		} catch (error) {
			void panel.webview.postMessage({ type: 'detailsError', message: errorMessage(error) });
		}
	}
}

async function listResource(server: ContainerServer, resource: ResourceType): Promise<ResourceRow[]> {
	const output = await executeContainerCommand(server, listArguments(server.runtime, resource));
	const values = parseListOutput(output, server.runtime);
	return values.map(value => normalizeResourceRow(server.runtime, resource, value));
}

async function inspectResourceDetails(server: ContainerServer, resource: ResourceType, id: string): Promise<unknown> {
	const output = await executeContainerCommand(server, inspectArguments(server.runtime, resource, id));
	return JSON.parse(output);
}

async function readServiceState(server: ContainerServer): Promise<ServiceState> {
	if (server.runtime === 'apple') {
		const output = await executeContainerCommand(server, ['system', 'status']);
		const match = /^status\s+(\S+)/im.exec(output);
		return match?.[1].toLowerCase() === 'running' ? 'running' : 'stopped';
	}
	await executeContainerCommand(server, server.runtime === 'docker'
		? ['info', '--format', '{{.ServerVersion}}']
		: ['info', '--format', 'json']);
	return 'running';
}

async function executeContainerCommand(server: ContainerServer, args: string[]): Promise<string> {
	try {
		const { stdout } = await execFileAsync(server.executablePath, args, {
			encoding: 'utf8',
			maxBuffer: 20 * 1024 * 1024,
		});
		return stdout.trim();
	} catch (error) {
		if (isExecError(error)) {
			const detail = error.stderr?.trim() || error.message;
			throw new Error(`${server.runtime} command failed: ${detail}`);
		}
		throw error;
	}
}

function listArguments(runtime: ContainerServer['runtime'], resource: ResourceType): string[] {
	if (runtime === 'apple') {
		switch (resource) {
			case 'containers': return ['list', '--all', '--format', 'json'];
			case 'images': return ['image', 'list', '--format', 'json'];
			case 'volumes': return ['volume', 'list', '--format', 'json'];
			case 'networks': return ['network', 'list', '--format', 'json'];
		}
	}
	if (runtime === 'podman') {
		switch (resource) {
			case 'containers': return ['ps', '--all', '--format', 'json'];
			case 'images': return ['image', 'ls', '--format', 'json'];
			case 'volumes': return ['volume', 'ls', '--format', 'json'];
			case 'networks': return ['network', 'ls', '--format', 'json'];
		}
	}
	switch (resource) {
		case 'containers': return ['ps', '--all', '--format', '{{json .}}'];
		case 'images': return ['image', 'ls', '--format', '{{json .}}'];
		case 'volumes': return ['volume', 'ls', '--format', '{{json .}}'];
		case 'networks': return ['network', 'ls', '--format', '{{json .}}'];
	}
}

function inspectArguments(runtime: ContainerServer['runtime'], resource: ResourceType, id: string): string[] {
	if (runtime === 'apple') {
		switch (resource) {
			case 'containers': return ['inspect', id];
			case 'images': return ['image', 'inspect', id];
			case 'volumes': return ['volume', 'inspect', id];
			case 'networks': return ['network', 'inspect', id];
		}
	}
	switch (resource) {
		case 'containers': return ['inspect', id];
		case 'images': return ['image', 'inspect', id];
		case 'volumes': return ['volume', 'inspect', id];
		case 'networks': return ['network', 'inspect', id];
	}
}

function parseListOutput(output: string, runtime: ContainerServer['runtime']): Record<string, unknown>[] {
	if (!output) {
		return [];
	}
	if (runtime !== 'docker') {
		const parsed: unknown = JSON.parse(output);
		if (!Array.isArray(parsed)) {
			throw new Error(`Unexpected ${runtime} list output.`);
		}
		return parsed.filter(isRecord);
	}
	return output.split(/\r?\n/).filter(Boolean).map(line => {
		const value: unknown = JSON.parse(line);
		if (!isRecord(value)) {
			throw new Error('Unexpected docker list output.');
		}
		return value;
	});
}

function normalizeResourceRow(
	runtime: ContainerServer['runtime'],
	resource: ResourceType,
	value: Record<string, unknown>,
): ResourceRow {
	if (runtime === 'apple') {
		return normalizeAppleResourceRow(resource, value);
	}
	switch (resource) {
		case 'containers': {
			const id = stringValue(value, 'ID', 'Id', 'Id', 'id');
			return {
				id,
				name: displayValue(value.Names) || stringValue(value, 'Name', 'Names') || shortId(id),
				status: stringValue(value, 'State', 'Status'),
				detail: [stringValue(value, 'Image'), stringValue(value, 'Status')].filter(Boolean).join(' · '),
				size: displayValue(value.Size),
			};
		}
		case 'images': {
			const id = stringValue(value, 'ID', 'Id', 'id');
			const repository = stringValue(value, 'Repository', 'RepoTags', 'Names');
			const tag = stringValue(value, 'Tag');
			return {
				id,
				name: tag && repository ? `${repository}:${tag}` : repository || '<none>',
				status: stringValue(value, 'CreatedSince', 'CreatedAt', 'Created'),
				detail: shortId(id),
				size: displayValue(value.Size),
			};
		}
		case 'volumes': {
			const name = stringValue(value, 'Name', 'name');
			return { id: name, name, status: stringValue(value, 'Driver', 'driver'), detail: stringValue(value, 'Mountpoint', 'Scope'), size: '' };
		}
		case 'networks': {
			const id = stringValue(value, 'ID', 'Id', 'id', 'Name');
			return { id, name: stringValue(value, 'Name', 'name') || shortId(id), status: stringValue(value, 'Driver', 'driver'), detail: stringValue(value, 'Scope', 'NetworkInterface'), size: '' };
		}
	}
}

function normalizeAppleResourceRow(resource: ResourceType, value: Record<string, unknown>): ResourceRow {
	const configuration = recordValue(value.configuration);
	const status = recordValue(value.status);
	const id = stringValue(value, 'id') || stringValue(configuration, 'id', 'name');
	switch (resource) {
		case 'containers': {
			const image = recordValue(configuration.image);
			return { id, name: stringValue(configuration, 'id') || id, status: stringValue(status, 'state'), detail: stringValue(image, 'reference'), size: '' };
		}
		case 'images': {
			const descriptor = recordValue(configuration.descriptor);
			const name = stringValue(configuration, 'name');
			return { id: name || id, name: name || shortId(id), status: stringValue(configuration, 'creationDate'), detail: shortId(id), size: formatBytes(numberValue(descriptor.size)) };
		}
		case 'volumes': return { id, name: stringValue(configuration, 'name') || id, status: stringValue(configuration, 'driver', 'format'), detail: stringValue(configuration, 'mountPoint', 'path'), size: '' };
		case 'networks': return { id, name: stringValue(configuration, 'name') || id, status: stringValue(configuration, 'plugin', 'mode'), detail: [stringValue(status, 'ipv4Subnet'), stringValue(status, 'ipv6Subnet')].filter(Boolean).join(' · '), size: '' };
	}
}

function renderContainerEditor(webview: vscode.Webview, extensionUri: vscode.Uri, server: ContainerServer): string {
	const nonce = createNonce();
	const codiconsUri = webview.asWebviewUri(vscode.Uri.joinPath(codiconsDistUri(extensionUri), 'codicon.css'));
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<link rel="stylesheet" href="${codiconsUri}">
	<title>${escapeHtml(server.name)}</title>
	<style>
		:root { color-scheme: light dark; }
		* { box-sizing: border-box; }
		html, body { width: 100%; min-width: 300px; height: 100%; margin: 0; overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
		body { display: grid; grid-template-rows: 42px minmax(0, 1fr); padding: 4px; user-select: none; }
		button { font: inherit; }
		.toolbar { display: flex; min-width: 0; padding: 0 8px; align-items: center; gap: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
		.connection-name { min-width: 0; overflow: hidden; font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
		.runtime { color: var(--vscode-descriptionForeground); font-size: 12px; text-transform: capitalize; }
		.service-status { display: inline-flex; min-width: 0; margin-left: auto; align-items: center; gap: 6px; color: var(--vscode-descriptionForeground); font-size: 12px; }
		.service-status .codicon { font-size: 13px; }
		.service-status.running { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
		.service-status.stopped, .service-status.error { color: var(--vscode-errorForeground); }
		.system-actions { display: flex; align-items: center; gap: 2px; }
		.workspace { display: grid; min-width: 0; min-height: 0; grid-template-columns: 190px minmax(0, 1fr); }
		.sidebar { min-width: 0; min-height: 0; padding: 8px 6px; overflow: auto; border-right: 1px solid var(--vscode-panel-border); }
		.nav { display: grid; gap: 2px; }
		.nav-button { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px; padding: 5px 9px; color: var(--vscode-foreground); background: transparent; border: 0; border-radius: 4px; font: inherit; text-align: left; cursor: pointer; }
		.nav-button:hover { background: var(--vscode-list-hoverBackground); }
		.nav-button[aria-selected="true"] { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
		.main { min-width: 0; min-height: 0; overflow: hidden; }
		.icon-button { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; color: var(--vscode-foreground); background: transparent; border: 0; border-radius: 4px; cursor: pointer; }
		.icon-button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
		.icon-button:disabled { opacity: 0.4; cursor: default; }
		.content { height: 100%; min-height: 0; }
		.message { padding: 28px 12px; color: var(--vscode-descriptionForeground); text-align: center; }
		.error { color: var(--vscode-errorForeground); }
		.table-wrap { width: 100%; height: 100%; overflow: auto; }
		table { width: 100%; border-collapse: collapse; table-layout: fixed; }
		th, td { height: 32px; padding: 0 10px; overflow: hidden; border: 0; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
		th { position: sticky; z-index: 2; top: 0; height: 30px; border-bottom: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); font-size: 12px; font-weight: 400; }
		tbody tr:hover { background: var(--vscode-list-hoverBackground); }
		.name { width: 28%; }
		.status { width: 17%; }
		.size { width: 100px; }
		.actions { width: 106px; padding: 3px 8px; text-align: center; }
		.action-buttons { display: flex; align-items: center; justify-content: flex-end; gap: 2px; }
		.dialog-backdrop { position: fixed; z-index: 10; inset: 0; display: grid; padding: 24px; align-items: center; justify-items: center; background: rgba(0, 0, 0, 0.45); }
		.details-dialog { display: grid; width: min(840px, 100%); height: min(760px, 100%); min-height: 0; overflow: hidden; grid-template-rows: 42px minmax(0, 1fr); border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-editor-background); box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35); }
		.details-header { display: flex; min-width: 0; padding: 0 6px 0 14px; align-items: center; border-bottom: 1px solid var(--vscode-panel-border); }
		.details-header h2 { min-width: 0; margin: 0; overflow: hidden; font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
		.details-header .icon-button { margin-left: auto; }
		pre { max-height: 46vh; margin: 0; overflow: auto; padding: 12px; color: var(--vscode-editor-foreground); background: var(--vscode-textCodeBlock-background); border-radius: 4px; font: 12px/1.55 var(--vscode-editor-font-family); white-space: pre-wrap; word-break: break-word; }
		.details-dialog pre { max-height: none; border-radius: 0; }
		[hidden] { display: none !important; }
		@media (max-width: 640px) {
			.workspace { grid-template-columns: 1fr; grid-template-rows: 41px minmax(0, 1fr); }
			.sidebar { z-index: 3; padding: 4px 8px; overflow: visible; border-right: 0; border-bottom: 1px solid var(--vscode-panel-border); }
			.nav { grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0; }
			.nav-button { justify-content: center; padding-inline: 4px; }
			.nav-button span:last-child { display: none; }
			.size { display: none; }
			.runtime { display: none; }
		}
	</style>
</head>
<body>
	<header class="toolbar">
		<span class="connection-name" title="${escapeHtml(server.executablePath)}">${escapeHtml(server.name)}</span>
		<span class="runtime">${escapeHtml(server.runtime)}</span>
		<span id="service-status" class="service-status checking" role="status" aria-live="polite"><i class="codicon codicon-loading codicon-modifier-spin"></i><span>Checking service</span></span>
		${server.runtime === 'apple' ? `<div class="system-actions" role="toolbar" aria-label="Apple Container system">
			<button id="system-action" class="icon-button" type="button" title="Start Apple Container system" aria-label="Start Apple Container system" disabled><i class="codicon codicon-play"></i></button>
		</div>` : ''}
		<button id="refresh" class="icon-button" type="button" title="Refresh" aria-label="Refresh"><i class="codicon codicon-refresh"></i></button>
	</header>
	<div class="workspace">
		<aside class="sidebar">
			<nav class="nav" aria-label="Container resources">
				<button class="nav-button" data-resource="containers" aria-selected="true"><span class="codicon codicon-server-process"></span><span>Containers</span></button>
				<button class="nav-button" data-resource="images" aria-selected="false"><span class="codicon codicon-package"></span><span>Images</span></button>
				<button class="nav-button" data-resource="volumes" aria-selected="false"><span class="codicon codicon-database"></span><span>Volumes</span></button>
				<button class="nav-button" data-resource="networks" aria-selected="false"><span class="codicon codicon-type-hierarchy-sub"></span><span>Networks</span></button>
			</nav>
		</aside>
		<main class="main">
			<div class="content">
				<div id="message" class="message">Connecting...</div>
				<div id="table-wrap" class="table-wrap" hidden>
					<table><thead><tr><th class="name">Name</th><th class="status">Status</th><th>Details</th><th class="size">Size</th><th class="actions" aria-label="Actions"></th></tr></thead><tbody id="rows"></tbody></table>
				</div>
			</div>
		</main>
	</div>
	<div id="details" class="dialog-backdrop" hidden>
		<section class="details-dialog" role="dialog" aria-modal="true" aria-labelledby="details-title">
			<header class="details-header"><h2 id="details-title">Details</h2><button id="details-close" class="icon-button" type="button" title="Close" aria-label="Close"><i class="codicon codicon-close"></i></button></header>
			<pre id="details-content"></pre>
		</section>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const message = document.getElementById('message');
		const tableWrap = document.getElementById('table-wrap');
		const rows = document.getElementById('rows');
		const details = document.getElementById('details');
		const detailsTitle = document.getElementById('details-title');
		const detailsContent = document.getElementById('details-content');
		const serviceStatus = document.getElementById('service-status');
		const systemAction = document.getElementById('system-action');
		let resource = 'containers';
		let serviceState = 'checking';
		let systemActionPending = false;
		let containerActionPendingId = '';
		const load = () => vscode.postMessage({ type: 'load', resource });
		for (const button of document.querySelectorAll('.nav-button')) {
			button.addEventListener('click', () => {
				resource = button.dataset.resource;
				for (const candidate of document.querySelectorAll('.nav-button')) candidate.setAttribute('aria-selected', String(candidate === button));
				details.hidden = true;
				load();
			});
		}
		document.getElementById('refresh').addEventListener('click', load);
		systemAction?.addEventListener('click', () => vscode.postMessage({ type: 'systemAction', action: serviceState === 'running' ? 'stop' : 'start' }));
		document.getElementById('details-close').addEventListener('click', closeDetails);
		details.addEventListener('click', event => { if (event.target === details) closeDetails(); });
		document.addEventListener('keydown', event => { if (event.key === 'Escape' && !details.hidden) closeDetails(); });
		window.addEventListener('message', event => {
			const data = event.data;
			if (data.type === 'serviceStatus') {
				serviceState = data.state;
				const labels = { checking: 'Checking service', running: 'Running', stopped: 'Stopped', error: data.message || 'Unavailable' };
				const icons = { checking: 'loading codicon-modifier-spin', running: 'pass-filled', stopped: 'circle-slash', error: 'error' };
				serviceStatus.className = 'service-status ' + serviceState;
				serviceStatus.title = data.message || labels[serviceState];
				serviceStatus.replaceChildren(Object.assign(document.createElement('i'), { className: 'codicon codicon-' + icons[serviceState] }), Object.assign(document.createElement('span'), { textContent: labels[serviceState] }));
				updateSystemActions();
				return;
			}
			if (data.type === 'systemActionPending') {
				systemActionPending = true;
				serviceStatus.querySelector('span').textContent = data.action === 'start' ? 'Starting...' : 'Stopping...';
				updateSystemActions();
				return;
			}
			if (data.type === 'systemActionComplete') {
				systemActionPending = false;
				updateSystemActions();
				return;
			}
			if (data.type === 'containerActionPending') {
				containerActionPendingId = data.id;
				updateContainerActions();
				return;
			}
			if (data.type === 'containerActionComplete') {
				containerActionPendingId = '';
				updateContainerActions();
				return;
			}
			if (data.type === 'containerActionError') {
				message.className = 'message error';
				message.textContent = data.message;
				message.hidden = false;
				return;
			}
			if (data.resource && data.resource !== resource) return;
			if (data.type === 'loading') {
				message.className = 'message';
				message.textContent = 'Loading...';
				message.hidden = false;
				tableWrap.hidden = true;
				return;
			}
			if (data.type === 'error') {
				message.className = 'message error';
				message.textContent = data.message;
				message.hidden = false;
				tableWrap.hidden = true;
				return;
			}
			if (data.type === 'resource') {
				containerActionPendingId = '';
				rows.replaceChildren(...data.rows.map(row => {
					const tr = document.createElement('tr');
					tr.dataset.id = row.id;
					for (const [value, className] of [[row.name, 'name'], [row.status, 'status'], [row.detail, ''], [row.size, 'size']]) {
						const td = document.createElement('td');
						td.textContent = value;
						td.title = value;
						td.className = className;
						tr.append(td);
					}
					const actions = document.createElement('td');
					actions.className = 'actions';
					const actionButtons = document.createElement('div');
					actionButtons.className = 'action-buttons';
					if (resource === 'containers') {
						const running = isContainerRunning(row.status);
						actionButtons.append(createContainerActionButton(row, running ? 'stop' : 'start'));
					}
					const inspectButton = document.createElement('button');
					inspectButton.className = 'icon-button';
					inspectButton.type = 'button';
					inspectButton.title = 'Show details';
					inspectButton.setAttribute('aria-label', 'Show details for ' + row.name);
					inspectButton.innerHTML = '<i class="codicon codicon-info"></i>';
					inspectButton.addEventListener('click', () => {
						detailsTitle.textContent = row.name;
						details.hidden = false;
						detailsContent.textContent = 'Loading details...';
						vscode.postMessage({ type: 'inspect', resource, id: row.id });
						document.getElementById('details-close').focus();
					});
					actionButtons.append(inspectButton);
					actions.append(actionButtons);
					tr.append(actions);
					return tr;
				}));
				message.hidden = data.rows.length > 0;
				message.className = 'message';
				message.textContent = 'No resources found.';
				tableWrap.hidden = data.rows.length === 0;
				return;
			}
			if (data.type === 'details') detailsContent.textContent = JSON.stringify(data.details, null, 2);
			if (data.type === 'detailsError') detailsContent.textContent = data.message;
		});
		function updateSystemActions() {
			if (!systemAction) return;
			const stopping = serviceState === 'running';
			const label = stopping ? 'Stop Apple Container system' : 'Start Apple Container system';
			systemAction.disabled = systemActionPending || serviceState === 'checking';
			systemAction.title = label;
			systemAction.setAttribute('aria-label', label);
			systemAction.firstElementChild.className = 'codicon codicon-' + (systemActionPending ? 'loading codicon-modifier-spin' : stopping ? 'debug-stop' : 'play');
		}
		function createContainerActionButton(row, action) {
			const button = document.createElement('button');
			const label = (action === 'start' ? 'Start ' : 'Stop ') + row.name;
			button.className = 'icon-button container-action';
			button.type = 'button';
			button.title = label;
			button.setAttribute('aria-label', label);
			button.innerHTML = '<i class="codicon codicon-' + (action === 'start' ? 'play' : 'debug-stop') + '"></i>';
			button.addEventListener('click', () => vscode.postMessage({ type: 'containerAction', id: row.id, action }));
			return button;
		}
		function updateContainerActions() {
			for (const button of document.querySelectorAll('.container-action')) {
				button.disabled = Boolean(containerActionPendingId);
			}
		}
		function isContainerRunning(status) {
			return /^(running|up)\\b/i.test(status.trim());
		}
		function closeDetails() {
			details.hidden = true;
		}
	</script>
</body>
</html>`;
}

function isResourceType(value: unknown): value is ResourceType {
	return value === 'containers' || value === 'images' || value === 'volumes' || value === 'networks';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function stringValue(value: Record<string, unknown>, ...keys: string[]): string {
	for (const key of keys) {
		const result = displayValue(value[key]);
		if (result) {
			return result;
		}
	}
	return '';
}

function displayValue(value: unknown): string {
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	if (Array.isArray(value)) {
		return value.map(displayValue).filter(Boolean).join(', ');
	}
	return '';
}

function numberValue(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isExecError(error: unknown): error is Error & { stderr?: string } {
	return error instanceof Error;
}

function shortId(id: string): string {
	return id.replace(/^sha256:/, '').slice(0, 12);
}

function formatBytes(value: number | undefined): string {
	if (!value) {
		return '';
	}
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
	return `${(value / (1024 ** unit)).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(timestamp: number): string {
	return new Date(timestamp * 1000).toLocaleString();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
