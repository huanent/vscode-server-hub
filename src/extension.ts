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

interface RemoteMetrics {
	cpuTotalTicks: number | undefined;
	cpuIdleTicks: number | undefined;
	cpuUsage: number | undefined;
	memoryUsedMb: number | undefined;
	memoryTotalMb: number | undefined;
	diskUsage: number | undefined;
	networkInterface: string | undefined;
	networkRxBytes: number | undefined;
	networkTxBytes: number | undefined;
}

interface NetworkSample {
	timestamp: number;
	rxBytes: number;
	txBytes: number;
	name: string;
}

interface CpuSample {
	timestamp: number;
	totalTicks: number;
	idleTicks: number;
}

const remoteMetricsCommand = String.raw`sh -lc '
if [ -r /proc/stat ]; then
	cpu=$(awk '\''/^cpu / { total = 0; for (i = 2; i <= NF; i++) total += $i; idle = $5; if (NF >= 6) idle += $6; printf "%.0f %.0f", total, idle; exit }'\'' /proc/stat 2>/dev/null)
	mem=$(awk '\''/MemTotal:/ { total = $2 } /MemAvailable:/ { avail = $2 } END { if (total > 0) printf "%.0f %.0f", (total - avail) / 1024, total / 1024 }'\'' /proc/meminfo 2>/dev/null)
	disk=$(df -Pk / 2>/dev/null | awk '\''NR == 2 { gsub("%", "", $5); print $5 }'\'')
	net=$(awk '\''/:/ { gsub(":", "", $1); if ($1 != "lo" && ($2 + $10) > 0) { print $1, $2, $10; exit } }'\'' /proc/net/dev 2>/dev/null)
	set -- $cpu
	cpu_total=$1
	cpu_idle=$2
	set -- $mem
	mem_used=$1
	mem_total=$2
	set -- $net
	net_if=$1
	net_rx=$2
	net_tx=$3
	printf "cpu_total=%s\ncpu_idle=%s\nmem_used=%s\nmem_total=%s\ndisk=%s\nnet_if=%s\nnet_rx=%s\nnet_tx=%s\n" "$cpu_total" "$cpu_idle" "$mem_used" "$mem_total" "$disk" "$net_if" "$net_rx" "$net_tx"
	exit 0
fi

if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
	cpu=$(LC_ALL=C top -l 2 -n 0 2>/dev/null | awk -F'\''[:,% ]+'\'' '\''/CPU usage/ { value = $4 + $6 } END { print value }'\'')
	page_size=$(pagesize 2>/dev/null)
	mem_total=$(awk '\''BEGIN { printf "%.0f", '\''"$(sysctl -n hw.memsize 2>/dev/null)"'\'' / 1024 / 1024 }'\'')
	free_pages=$(vm_stat 2>/dev/null | awk '\''/Pages free/ { gsub("\\.", "", $3); free = $3 } /Pages inactive/ { gsub("\\.", "", $3); inactive = $3 } /Pages speculative/ { gsub("\\.", "", $3); speculative = $3 } END { print free + inactive + speculative }'\'')
	mem_used=$(awk -v total="$mem_total" -v free="$free_pages" -v page="$page_size" '\''BEGIN { if (total > 0) printf "%.0f", total - ((free * page) / 1024 / 1024) }'\'')
	disk=$(df -Pk / 2>/dev/null | awk '\''NR == 2 { gsub("%", "", $5); print $5 }'\'')
	net_if=$(route -n get default 2>/dev/null | awk '\''/interface:/ { print $2; exit }'\'')
	net=$(netstat -bI "$net_if" 2>/dev/null | awk '\''NR == 2 { print $(NF - 1), $NF; exit }'\'')
	set -- $net
	net_rx=$1
	net_tx=$2
	printf "cpu_total=\ncpu_idle=\ncpu=%s\nmem_used=%s\nmem_total=%s\ndisk=%s\nnet_if=%s\nnet_rx=%s\nnet_tx=%s\n" "$cpu" "$mem_used" "$mem_total" "$disk" "$net_if" "$net_rx" "$net_tx"
	exit 0
fi

printf "cpu_total=\ncpu_idle=\ncpu=\nmem_used=\nmem_total=\ndisk=\nnet_if=\nnet_rx=\nnet_tx=\n"
'`;

class ServerTreeItem extends vscode.TreeItem {
	constructor(readonly server: SshServer) {
		super(server.name, vscode.TreeItemCollapsibleState.None);
		this.description = `${server.username}@${server.host}:${server.port}`;
		this.tooltip = `${server.name}\n${this.description}`;
		this.iconPath = new vscode.ThemeIcon('terminal-secure');
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
	private failed = false;
	private closed = false;
	private pollTimer: NodeJS.Timeout | undefined;
	private previousNetworkSample: NetworkSample | undefined;
	private previousCpuSample: CpuSample | undefined;
	private isRefreshing = false;

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
			.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
				finish(prompts.map(() => this.password));
			})
			.on('ready', () => {
				client.shell(this.shellOptions(), (error, stream) => {
					if (error) {
						this.fail(error);
						return;
					}

					this.stream = stream;
					this.initializeTerminalViewport();
					this.startMetricsPolling(client);
					stream.on('data', (data: Buffer) => this.writeEmitter.fire(data.toString()));
					stream.stderr.on('data', (data: Buffer) => this.writeEmitter.fire(data.toString()));
					stream.on('close', () => {
						this.stopMetricsPolling();
						this.client?.end();
						this.closed = true;
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
				tryKeyboard: true,
				readyTimeout: 15_000,
			});
	}

	close(): void {
		if (this.closed) {
			return;
		}

		this.closed = true;
		this.stopMetricsPolling();
		this.stream?.close();
		this.client?.end();
	}

	handleInput(data: string): void {
		this.stream?.write(data);
	}

	setDimensions(dimensions: vscode.TerminalDimensions): void {
		this.dimensions = dimensions;
		this.stream?.setWindow(dimensions.rows, dimensions.columns, 0, 0);
		this.initializeTerminalViewport();
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

	private initializeTerminalViewport(): void {
		if (!this.dimensions) {
			return;
		}

		const statusLine = this.buildStatusLine('Loading metrics...');
		this.writeEmitter.fire(`\u001b[r\u001b[2J\u001b[H${statusLine}\r\n\u001b[2;${this.dimensions.rows}r\u001b[2;1H`);
	}

	private startMetricsPolling(client: Client): void {
		this.stopMetricsPolling();
		this.previousNetworkSample = undefined;
		this.previousCpuSample = undefined;
		void this.refreshMetrics(client);
		this.pollTimer = setInterval(() => {
			void this.refreshMetrics(client);
		}, 5000);
	}

	private stopMetricsPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}

		this.previousNetworkSample = undefined;
		this.previousCpuSample = undefined;
	}

	private async refreshMetrics(client: Client): Promise<void> {
		if (this.closed || this.failed || this.isRefreshing) {
			return;
		}

		this.isRefreshing = true;
		try {
			const output = await execRemoteCommand(client, remoteMetricsCommand);
			if (this.closed || this.failed) {
				return;
			}

			const metrics = parseRemoteMetrics(output);
			this.renderStatusLine(this.formatMetrics(metrics));
		} catch {
			if (!this.closed && !this.failed) {
				this.renderStatusLine('Metrics unavailable');
			}
		} finally {
			this.isRefreshing = false;
		}
	}

	private formatMetrics(metrics: RemoteMetrics): string {
		const cpuUsage = this.formatCpu(metrics);
		const network = this.formatNetwork(metrics);
		return [
			formatMetricSlot('CPU', cpuUsage, 12),
			formatMetricSlot('MEM', formatMemory(metrics.memoryUsedMb, metrics.memoryTotalMb), 18),
			formatMetricSlot('DISK', formatPercent(metrics.diskUsage), 14),
			formatMetricSlot('NETWORK', network, 26),
		].join('  ');
	}

	private formatCpu(metrics: RemoteMetrics): string {
		if (metrics.cpuTotalTicks !== undefined && metrics.cpuIdleTicks !== undefined) {
			const currentSample: CpuSample = {
				timestamp: Date.now(),
				totalTicks: metrics.cpuTotalTicks,
				idleTicks: metrics.cpuIdleTicks,
			};
			const previousSample = this.previousCpuSample;
			this.previousCpuSample = currentSample;

			if (!previousSample) {
				return '--';
			}

			const totalDelta = currentSample.totalTicks - previousSample.totalTicks;
			const idleDelta = currentSample.idleTicks - previousSample.idleTicks;
			if (totalDelta <= 0) {
				return '--';
			}

			const usage = 100 * (1 - idleDelta / totalDelta);
			return formatPercent(clampPercent(usage));
		}

		return formatPercent(metrics.cpuUsage);
	}

	private formatNetwork(metrics: RemoteMetrics): string {
		if (!metrics.networkInterface || metrics.networkRxBytes === undefined || metrics.networkTxBytes === undefined) {
			return '--';
		}

		const currentSample: NetworkSample = {
			name: metrics.networkInterface,
			rxBytes: metrics.networkRxBytes,
			txBytes: metrics.networkTxBytes,
			timestamp: Date.now(),
		};
		const previousSample = this.previousNetworkSample;
		this.previousNetworkSample = currentSample;

		if (!previousSample || previousSample.name !== currentSample.name) {
			return '--';
		}

		const elapsedSeconds = (currentSample.timestamp - previousSample.timestamp) / 1000;
		if (elapsedSeconds <= 0) {
			return '--';
		}

		const rxRate = Math.max(0, currentSample.rxBytes - previousSample.rxBytes) / elapsedSeconds;
		const txRate = Math.max(0, currentSample.txBytes - previousSample.txBytes) / elapsedSeconds;
		return `${formatRate(rxRate)}↓ ${formatRate(txRate)}↑`;
	}

	private renderStatusLine(content: string): void {
		this.writeEmitter.fire(`\u001b7\u001b[1;1H${this.buildStatusLine(content)}\u001b8`);
	}

	private buildStatusLine(content: string): string {
		const columns = this.dimensions?.columns ?? 120;
		const plain = collapseWhitespace(content);
		const visible = plain.length >= columns ? `${plain.slice(0, Math.max(columns - 1, 1))}` : plain.padEnd(columns, ' ');
		return `\u001b[7m${visible}\u001b[0m`;
	}

	private fail(error: Error): void {
		if (this.failed) {
			return;
		}

		this.failed = true;
		this.stopMetricsPolling();
		const reason = error.message === 'All configured authentication methods failed'
			? 'Authentication failed. Check the username and password, and confirm that the server allows password authentication.'
			: error.message;
		const message = `Could not connect to “${this.server.name}”: ${reason}`;
		this.writeEmitter.fire(`\r\n${message}\r\n`);
		this.writeEmitter.fire('Connection terminal is kept open so you can review this error.\r\n');
		this.client?.end();
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
		void vscode.window.showErrorMessage(`Could not export servers: ${message}`);
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
		const password = passwordValue(message.password);
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

function parseRemoteMetrics(output: string): RemoteMetrics {
	const values = new Map<string, string>();
	for (const line of output.split(/\r?\n/u)) {
		const separatorIndex = line.indexOf('=');
		if (separatorIndex <= 0) {
			continue;
		}

		const key = line.slice(0, separatorIndex).trim();
		const value = line.slice(separatorIndex + 1).trim();
		values.set(key, value);
	}

	return {
		cpuTotalTicks: numberValue(values.get('cpu_total')),
		cpuIdleTicks: numberValue(values.get('cpu_idle')),
		cpuUsage: numberValue(values.get('cpu')),
		memoryUsedMb: numberValue(values.get('mem_used')),
		memoryTotalMb: numberValue(values.get('mem_total')),
		diskUsage: numberValue(values.get('disk')),
		networkInterface: stringOrUndefined(values.get('net_if')),
		networkRxBytes: numberValue(values.get('net_rx')),
		networkTxBytes: numberValue(values.get('net_tx')),
	};
}

function numberValue(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}

	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function stringOrUndefined(value: string | undefined): string | undefined {
	return value ? value : undefined;
}

function formatPercent(value: number | undefined): string {
	return value === undefined ? '--' : `${value.toFixed(1)}%`;
}

function formatMemory(usedMb: number | undefined, totalMb: number | undefined): string {
	if (usedMb === undefined || totalMb === undefined || totalMb <= 0) {
		return '--';
	}

	return `${formatMb(usedMb)}/${formatMb(totalMb)}`;
}

function formatMb(value: number): string {
	if (value >= 1024) {
		return `${(value / 1024).toFixed(1)}GB`;
	}

	return `${Math.round(value)}MB`;
}

function formatRate(bytesPerSecond: number): string {
	if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) {
		return '--';
	}

	if (bytesPerSecond >= 1024 * 1024) {
		return `${(bytesPerSecond / 1024 / 1024).toFixed(1)}MB/s`;
	}

	if (bytesPerSecond >= 1024) {
		return `${(bytesPerSecond / 1024).toFixed(1)}KB/s`;
	}

	return `${bytesPerSecond.toFixed(0)}B/s`;
}

function formatMetricSlot(label: string, value: string, width: number): string {
	const normalizedValue = collapseWhitespace(value) || '--';
	const contentWidth = Math.max(width - label.length - 1, 2);
	const trimmedValue = normalizedValue.length > contentWidth ? normalizedValue.slice(0, contentWidth) : normalizedValue;
	return `${label} ${trimmedValue.padStart(contentWidth, ' ')}`;
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}

	return Math.min(100, Math.max(0, value));
}

function collapseWhitespace(value: string): string {
	return value.replace(/\s+/gu, ' ').trim();
}

function execRemoteCommand(client: Client, command: string): Promise<string> {
	return new Promise((resolve, reject) => {
		client.exec(command, (error, stream) => {
			if (error) {
				reject(error);
				return;
			}

			let stdout = '';
			let stderr = '';
			stream.on('data', (data: Buffer) => {
				stdout += data.toString();
			});
			stream.stderr.on('data', (data: Buffer) => {
				stderr += data.toString();
			});
			stream.on('close', (code: number | undefined) => {
				if (code && code !== 0) {
					reject(new Error(stderr.trim() || `Remote metrics command exited with code ${code}.`));
					return;
				}

				resolve(stdout);
			});
		});
	});
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

function passwordValue(value: unknown): string {
	return typeof value === 'string' ? value : '';
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
