import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { ContainerServer, SshServer } from '../servers/server';
import { ServerStore } from '../servers/serverStore';
import { executeSshCommand } from '../ssh/sshCommand';
import { getWebviewHtml } from '../webview';

const execFileAsync = promisify(execFile);

type ResourceType = 'containers' | 'images' | 'volumes' | 'networks';

interface ContainerEditorMessage {
	type: 'ready' | 'load' | 'inspect' | 'systemAction' | 'containerAction';
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
	serverStore: ServerStore,
): void {
	panel.title = server.name;
	panel.iconPath = new vscode.ThemeIcon('server-process');
	panel.webview.options = {
		enableScripts: true,
		localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
	};
	panel.webview.html = getWebviewHtml(panel.webview, extensionUri, 'containerEditor', server.name);

	panel.webview.onDidReceiveMessage(async (message: ContainerEditorMessage) => {
		if (message.type === 'ready') {
			await panel.webview.postMessage({
				type: 'initialize',
				server: { name: server.name, runtime: server.runtime, executablePath: server.executablePath },
			});
			await refreshServiceStatus();
			await loadResource('containers');
			return;
		}
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

	async function refreshServiceStatus(): Promise<void> {
		void panel.webview.postMessage({ type: 'serviceStatus', state: 'checking' satisfies ServiceState });
		try {
			const state = await readServiceState(server, serverStore);
			void panel.webview.postMessage({ type: 'serviceStatus', state });
		} catch (error) {
			void panel.webview.postMessage({ type: 'serviceStatus', state: 'error' satisfies ServiceState, message: errorMessage(error) });
		}
	}

	async function changeAppleSystemState(action: 'start' | 'stop'): Promise<void> {
		void panel.webview.postMessage({ type: 'systemActionPending', action });
		try {
			await executeContainerCommand(server, serverStore, action === 'start'
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
			const rows = await listResource(server, serverStore, resource);
			void panel.webview.postMessage({ type: 'resource', resource, rows });
		} catch (error) {
			void panel.webview.postMessage({ type: 'error', resource, message: errorMessage(error) });
		}
	}

	async function changeContainerState(id: string, action: 'start' | 'stop'): Promise<void> {
		void panel.webview.postMessage({ type: 'containerActionPending', id, action });
		try {
			await executeContainerCommand(server, serverStore, [action, id]);
			await loadResource('containers');
		} catch (error) {
			void panel.webview.postMessage({ type: 'containerActionError', id, message: errorMessage(error) });
		} finally {
			void panel.webview.postMessage({ type: 'containerActionComplete', id });
		}
	}

	async function inspectResource(resource: ResourceType, id: string): Promise<void> {
		try {
			const details = await inspectResourceDetails(server, serverStore, resource, id);
			void panel.webview.postMessage({ type: 'details', resource, id, details });
		} catch (error) {
			void panel.webview.postMessage({ type: 'detailsError', message: errorMessage(error) });
		}
	}
}

async function listResource(server: ContainerServer, serverStore: ServerStore, resource: ResourceType): Promise<ResourceRow[]> {
	const output = await executeContainerCommand(server, serverStore, listArguments(server.runtime, resource));
	const values = parseListOutput(output, server.runtime);
	return values.map(value => normalizeResourceRow(server.runtime, resource, value));
}

async function inspectResourceDetails(server: ContainerServer, serverStore: ServerStore, resource: ResourceType, id: string): Promise<unknown> {
	const output = await executeContainerCommand(server, serverStore, inspectArguments(server.runtime, resource, id));
	return JSON.parse(output);
}

async function readServiceState(server: ContainerServer, serverStore: ServerStore): Promise<ServiceState> {
	if (server.runtime === 'apple') {
		const output = await executeContainerCommand(server, serverStore, ['system', 'status']);
		const match = /^status\s+(\S+)/im.exec(output);
		return match?.[1].toLowerCase() === 'running' ? 'running' : 'stopped';
	}
	await executeContainerCommand(server, serverStore, server.runtime === 'docker'
		? ['info', '--format', '{{.ServerVersion}}']
		: ['info', '--format', 'json']);
	return 'running';
}

async function executeContainerCommand(server: ContainerServer, serverStore: ServerStore, args: string[]): Promise<string> {
	if (server.connectionType === 'ssh') {
		const { sshServer, credentials } = await resolveSshConnection(server, serverStore);
		const command = [server.executablePath, ...args].map(shellQuote).join(' ');
		try {
			return await executeSshCommand(sshServer, credentials, command);
		} catch (error) {
			throw new Error(`${server.runtime} command failed: ${errorMessage(error)}`);
		}
	}
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

async function resolveSshConnection(server: ContainerServer, serverStore: ServerStore) {
	if (server.connectionType !== 'ssh') {
		throw new Error('The container server is not configured for SSH.');
	}
	if (server.sshServerId) {
		const sshServer = serverStore.getServers().find((candidate): candidate is SshServer => candidate.type === 'ssh' && candidate.id === server.sshServerId);
		if (!sshServer) {
			throw new Error('The selected SSH server no longer exists.');
		}
		return { sshServer, credentials: await serverStore.getCredentials(sshServer.id) };
	}
	if (!('authType' in server)) {
		throw new Error('The manual SSH configuration is invalid.');
	}
	const sshServer: SshServer = {
		id: server.id,
		type: 'ssh',
		name: server.name,
		group: server.group,
		host: server.host,
		port: server.port,
		username: server.username,
		authType: server.authType,
		...(server.proxyCommand ? { proxyCommand: server.proxyCommand } : {}),
	};
	return { sshServer, credentials: await serverStore.getCredentials(server.id) };
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
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
