import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { Client, ClientChannel } from 'ssh2';

const serversStateKey = 'server-hub.servers';

interface SshServer {
	id: string;
	name: string;
	host: string;
	port: number;
	username: string;
}

interface ExportedSshServer extends SshServer {
	password: string;
}

interface ServerExportFile {
	version: 1;
	servers: ExportedSshServer[];
}

interface ServerFormMessage {
	type: 'save';
	name?: unknown;
	host?: unknown;
	port?: unknown;
	username?: unknown;
	password?: unknown;
}

class ServerTreeItem extends vscode.TreeItem {
	constructor(readonly server: SshServer) {
		super(server.name, vscode.TreeItemCollapsibleState.None);
		this.description = `${server.username}@${server.host}:${server.port}`;
		this.tooltip = `${server.name}\n${this.description}`;
		this.iconPath = new vscode.ThemeIcon('terminal');
		this.contextValue = 'sshServer';
	}
}

class ServerTreeDataProvider implements vscode.TreeDataProvider<ServerTreeItem> {
	private readonly changeEmitter = new vscode.EventEmitter<ServerTreeItem | undefined>();
	readonly onDidChangeTreeData = this.changeEmitter.event;

	constructor(private readonly context: vscode.ExtensionContext) {}

	getTreeItem(element: ServerTreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(): ServerTreeItem[] {
		return this.context.globalState.get<SshServer[]>(serversStateKey, []).map(server => new ServerTreeItem(server));
	}

	refresh(): void {
		this.changeEmitter.fire(undefined);
	}
}

class SshPseudoterminal implements vscode.Pseudoterminal {
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	private readonly closeEmitter = new vscode.EventEmitter<number>();
	private client: Client | undefined;
	private stream: ClientChannel | undefined;
	private dimensions: vscode.TerminalDimensions | undefined;

	readonly onDidWrite = this.writeEmitter.event;
	readonly onDidClose = this.closeEmitter.event;

	constructor(
		private readonly server: SshServer,
		private readonly password: string,
	) {}

	open(initialDimensions: vscode.TerminalDimensions | undefined): void {
		this.dimensions = initialDimensions;
		this.writeEmitter.fire(`Connecting to ${this.server.username}@${this.server.host}:${this.server.port}...\r\n`);

		const client = new Client();
		this.client = client;
		client
			.on('ready', () => {
				client.shell(this.shellOptions(), (error, stream) => {
					if (error) {
						this.fail(error);
						return;
					}

					this.stream = stream;
					stream.on('data', (data: Buffer) => this.writeEmitter.fire(data.toString()));
					stream.stderr.on('data', (data: Buffer) => this.writeEmitter.fire(data.toString()));
					stream.on('close', () => {
						this.client?.end();
						this.closeEmitter.fire(0);
					});
				});
			})
			.on('error', error => this.fail(error))
			.connect({
				host: this.server.host,
				port: this.server.port,
				username: this.server.username,
				password: this.password,
				readyTimeout: 15_000,
			});
	}

	close(): void {
		this.stream?.close();
		this.client?.end();
	}

	handleInput(data: string): void {
		this.stream?.write(data);
	}

	setDimensions(dimensions: vscode.TerminalDimensions): void {
		this.dimensions = dimensions;
		this.stream?.setWindow(dimensions.rows, dimensions.columns, 0, 0);
	}

	private shellOptions(): false | { term: string; rows: number; cols: number } {
		if (!this.dimensions) {
			return false;
		}

		return {
			term: 'xterm-256color',
			rows: this.dimensions.rows,
			cols: this.dimensions.columns,
		};
	}

	private fail(error: Error): void {
		this.writeEmitter.fire(`\r\nConnection failed: ${error.message}\r\n`);
		this.client?.end();
		this.closeEmitter.fire(1);
	}
}

export function activate(context: vscode.ExtensionContext) {
	context.globalState.setKeysForSync([serversStateKey]);
	const treeDataProvider = new ServerTreeDataProvider(context);

	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('server-hub.servers', treeDataProvider),
		vscode.commands.registerCommand('server-hub.addServer', () => openServerPanel(context, treeDataProvider)),
		vscode.commands.registerCommand('server-hub.importServers', () => importServers(context, treeDataProvider)),
		vscode.commands.registerCommand('server-hub.exportServers', () => exportServers(context)),
		vscode.commands.registerCommand('server-hub.connectServer', (item: ServerTreeItem) => connectServer(context, item.server)),
		vscode.commands.registerCommand('server-hub.editServer', (item: ServerTreeItem) => openServerPanel(context, treeDataProvider, item.server)),
		vscode.commands.registerCommand('server-hub.deleteServer', (item: ServerTreeItem) => deleteServer(context, treeDataProvider, item.server)),
	);
}

export function deactivate() {}

async function exportServers(context: vscode.ExtensionContext): Promise<void> {
	const servers = context.globalState.get<SshServer[]>(serversStateKey, []);
	if (servers.length === 0) {
		void vscode.window.showInformationMessage('There are no SSH servers to export.');
		return;
	}

	const confirmation = await vscode.window.showWarningMessage(
		'The exported JSON file will contain passwords in plain text.',
		{ modal: true },
		'Export',
	);
	if (confirmation !== 'Export') {
		return;
	}

	const exportedServers = await Promise.all(servers.map(async server => ({
		...server,
		password: await context.secrets.get(passwordKey(server.id)) ?? '',
	})));
	const target = await vscode.window.showSaveDialog({
		filters: { JSON: ['json'] },
		defaultUri: vscode.Uri.joinPath(vscode.Uri.file(homedir()), 'server-hub-export.json'),
		saveLabel: 'Export',
	});
	if (!target) {
		return;
	}

	const data: ServerExportFile = { version: 1, servers: exportedServers };
	try {
		await vscode.workspace.fs.writeFile(target, Buffer.from(`${JSON.stringify(data, undefined, 2)}\n`, 'utf8'));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(`Could not export SSH servers: ${message}`);
		return;
	}
	void vscode.window.showInformationMessage(`Exported ${servers.length} SSH server${servers.length === 1 ? '' : 's'}.`);
}

async function importServers(
	context: vscode.ExtensionContext,
	treeDataProvider: ServerTreeDataProvider,
): Promise<void> {
	const selection = await vscode.window.showOpenDialog({
		canSelectMany: false,
		filters: { JSON: ['json'] },
		openLabel: 'Import',
	});
	if (!selection?.[0]) {
		return;
	}

	let importedServers: ExportedSshServer[];
	try {
		const contents = await vscode.workspace.fs.readFile(selection[0]);
		importedServers = parseServerExportFile(JSON.parse(Buffer.from(contents).toString('utf8')));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(`Could not import SSH servers: ${message}`);
		return;
	}

	const confirmation = await vscode.window.showWarningMessage(
		`Import ${importedServers.length} SSH server${importedServers.length === 1 ? '' : 's'} and store the included passwords? Existing servers with the same ID will be updated.`,
		{ modal: true },
		'Import',
	);
	if (confirmation !== 'Import') {
		return;
	}

	const servers = context.globalState.get<SshServer[]>(serversStateKey, []);
	const importedIds = new Set(importedServers.map(server => server.id));
	const updatedServers = [
		...servers.filter(server => !importedIds.has(server.id)),
		...importedServers.map(({ password: _password, ...server }) => server),
	];
	await context.globalState.update(serversStateKey, updatedServers);
	await Promise.all(importedServers.map(server => server.password
		? context.secrets.store(passwordKey(server.id), server.password)
		: context.secrets.delete(passwordKey(server.id))));
	treeDataProvider.refresh();
	void vscode.window.showInformationMessage(`Imported ${importedServers.length} SSH server${importedServers.length === 1 ? '' : 's'}.`);
}

function parseServerExportFile(value: unknown): ExportedSshServer[] {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.servers)) {
		throw new Error('The file is not a supported Server Hub export.');
	}

	const serverIds = new Set<string>();
	return value.servers.map((entry, index) => {
		if (!isRecord(entry)) {
			throw new Error(`Server ${index + 1} is invalid.`);
		}

		const id = stringValue(entry.id);
		const server = parseServer({
			type: 'save',
			name: entry.name,
			host: entry.host,
			port: entry.port,
			username: entry.username,
		}, id);
		if (!id || !server || typeof entry.password !== 'string') {
			throw new Error(`Server ${index + 1} has invalid or missing fields.`);
		}
		if (serverIds.has(id)) {
			throw new Error(`Server ${index + 1} uses a duplicate ID.`);
		}

		serverIds.add(id);
		return { ...server, password: entry.password };
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function openServerPanel(
	context: vscode.ExtensionContext,
	treeDataProvider: ServerTreeDataProvider,
	existingServer?: SshServer,
): void {
	const isEditing = existingServer !== undefined;
	const panel = vscode.window.createWebviewPanel(
		'server-hub.serverForm',
		isEditing ? 'Edit Server' : 'Add Server',
		vscode.ViewColumn.Active,
		{ enableScripts: true },
	);

	panel.webview.html = getServerFormHtml(panel.webview, existingServer);
	panel.webview.onDidReceiveMessage(async (message: ServerFormMessage) => {
		if (message.type !== 'save') {
			return;
		}

		const server = parseServer(message, existingServer?.id);
		const password = stringValue(message.password);
		if (!server || (!isEditing && !password)) {
			void panel.webview.postMessage({ type: 'error', message: 'Please complete all required fields.' });
			return;
		}

		const servers = context.globalState.get<SshServer[]>(serversStateKey, []);
		const updatedServers = isEditing
			? servers.map(current => current.id === server.id ? server : current)
			: [...servers, server];
		await context.globalState.update(serversStateKey, updatedServers);
		if (password) {
			await context.secrets.store(passwordKey(server.id), password);
		}
		treeDataProvider.refresh();
		panel.dispose();
		void vscode.window.showInformationMessage(`${isEditing ? 'Updated' : 'Saved'} SSH server “${server.name}”.`);
	}, undefined, context.subscriptions);
}

async function deleteServer(
	context: vscode.ExtensionContext,
	treeDataProvider: ServerTreeDataProvider,
	server: SshServer,
): Promise<void> {
	const confirmation = await vscode.window.showWarningMessage(
		`Delete server “${server.name}”?`,
		{ modal: true },
		'Delete',
	);
	if (confirmation !== 'Delete') {
		return;
	}

	const servers = context.globalState.get<SshServer[]>(serversStateKey, []);
	await context.globalState.update(serversStateKey, servers.filter(current => current.id !== server.id));
	await context.secrets.delete(passwordKey(server.id));
	treeDataProvider.refresh();
}

async function connectServer(context: vscode.ExtensionContext, server: SshServer): Promise<void> {
	const password = await context.secrets.get(passwordKey(server.id));
	if (!password) {
		void vscode.window.showErrorMessage(`No password is available for “${server.name}” on this device.`);
		return;
	}

	const terminal = vscode.window.createTerminal({
		name: server.name,
		pty: new SshPseudoterminal(server, password),
		location: vscode.TerminalLocation.Editor,
		iconPath: new vscode.ThemeIcon('remote'),
	});
	terminal.show();
}

function parseServer(message: ServerFormMessage, serverId?: string): SshServer | undefined {
	const name = stringValue(message.name);
	const host = stringValue(message.host);
	const username = stringValue(message.username);
	const port = Number(message.port);
	if (!name || !host || !username || !Number.isInteger(port) || port < 1 || port > 65_535) {
		return undefined;
	}

	return {
		id: serverId ?? crypto.randomUUID(),
		name,
		host,
		port,
		username,
	};
}

function stringValue(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function passwordKey(serverId: string): string {
	return `server-hub.password.${serverId}`;
}

function getServerFormHtml(webview: vscode.Webview, server?: SshServer): string {
	const nonce = crypto.randomUUID().replaceAll('-', '');
	const isEditing = server !== undefined;
	const title = isEditing ? 'Edit Server' : 'Add Server';
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
	<p>Connection details are synced. The password remains encrypted on this device.</p>
	<form id="server-form">
		<label>Name<input name="name" autocomplete="off" required autofocus placeholder="Production" value="${escapeHtml(server?.name ?? '')}"></label>
		<div class="connection">
			<label>Host<input name="host" autocomplete="off" required placeholder="server.example.com" value="${escapeHtml(server?.host ?? '')}"></label>
			<label>Port<input name="port" type="number" min="1" max="65535" value="${server?.port ?? 22}" required></label>
		</div>
		<label>Username<input name="username" autocomplete="username" required placeholder="root" value="${escapeHtml(server?.username ?? '')}"></label>
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
