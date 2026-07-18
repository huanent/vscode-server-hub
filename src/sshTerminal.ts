import * as vscode from 'vscode';
import { Client, ClientChannel } from 'ssh2';
import { RemoteMetricsFormatter, RemoteMetricsReader } from './remoteMetrics';
import { SshServer } from './server';

interface SshWebviewMessage {
	type: 'input' | 'resize' | 'ready';
	data?: unknown;
	rows?: unknown;
	columns?: unknown;
}

const metricsRefreshIntervalMs = 5000;

export function openSshTerminal(extensionUri: vscode.Uri, server: SshServer, password: string): void {
	const xtermRoot = vscode.Uri.joinPath(extensionUri, 'resources', 'xterm');
	const panel = vscode.window.createWebviewPanel(
		'server-hub.sshTerminal',
		server.name,
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [xtermRoot],
		},
	);
	panel.iconPath = new vscode.ThemeIcon('terminal-linux');
	panel.webview.html = renderSshTerminal(panel.webview, xtermRoot, server);

	const session = new SshWebviewSession(panel, server, password);
	panel.onDidDispose(() => session.dispose());
	panel.webview.onDidReceiveMessage((message: SshWebviewMessage) => session.handleMessage(message));
}

class SshWebviewSession {
	private readonly client = new Client();
	private readonly metricsReader = new RemoteMetricsReader();
	private readonly metricsFormatter = new RemoteMetricsFormatter();
	private shellStream: ClientChannel | undefined;
	private dimensions: { rows: number; columns: number } | undefined;
	private metricsTimer: NodeJS.Timeout | undefined;
	private metricsRequestPending = false;
	private webviewReady = false;
	private connected = false;
	private disposed = false;
	private failed = false;

	constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly server: SshServer,
		private readonly password: string,
	) {}

	handleMessage(message: SshWebviewMessage): void {
		if (message.type === 'ready' && !this.webviewReady) {
			this.webviewReady = true;
			this.connect();
			return;
		}
		if (message.type === 'input' && typeof message.data === 'string') {
			this.shellStream?.write(message.data);
			return;
		}
		if (
			message.type === 'resize'
			&& typeof message.rows === 'number'
			&& Number.isInteger(message.rows)
			&& message.rows > 0
			&& typeof message.columns === 'number'
			&& Number.isInteger(message.columns)
			&& message.columns > 0
		) {
			this.dimensions = { rows: message.rows, columns: message.columns };
			this.shellStream?.setWindow(message.rows, message.columns, 0, 0);
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.stopMetricsPolling();
		this.shellStream?.close();
		this.client.end();
	}

	private connect(): void {
		this.postMessage({ type: 'status', status: 'connecting', message: `Connecting to ${this.server.username}@${this.server.host}:${this.server.port}...` });
		this.client
			.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
				finish(prompts.map(() => this.password));
			})
			.on('ready', () => this.openRemoteShell())
			.on('error', error => this.handleConnectionFailure(error))
			.connect({
				host: this.server.host,
				port: this.server.port,
				username: this.server.username,
				password: this.password,
				tryKeyboard: true,
				readyTimeout: 15_000,
			});
	}

	private openRemoteShell(): void {
		const rows = this.dimensions?.rows ?? 24;
		const columns = this.dimensions?.columns ?? 80;
		this.client.shell({ term: 'xterm-256color', rows, cols: columns }, (error, stream) => {
			if (error) {
				this.handleConnectionFailure(error);
				return;
			}

			this.connected = true;
			this.shellStream = stream;
			this.postMessage({ type: 'status', status: 'connected', message: 'Connected' });
			stream.on('data', (data: Buffer) => this.postMessage({ type: 'output', data: data.toString('base64') }));
			stream.stderr.on('data', (data: Buffer) => this.postMessage({ type: 'output', data: data.toString('base64') }));
			stream.on('close', () => this.handleShellClosed());
			this.startMetricsPolling();
		});
	}

	private startMetricsPolling(): void {
		this.stopMetricsPolling();
		this.metricsFormatter.reset();
		void this.refreshMetrics();
		this.metricsTimer = setInterval(() => void this.refreshMetrics(), metricsRefreshIntervalMs);
	}

	private stopMetricsPolling(): void {
		if (this.metricsTimer) {
			clearInterval(this.metricsTimer);
			this.metricsTimer = undefined;
		}
		this.metricsFormatter.reset();
	}

	private async refreshMetrics(): Promise<void> {
		if (this.disposed || this.failed || !this.connected || this.metricsRequestPending) {
			return;
		}

		this.metricsRequestPending = true;
		try {
			const metrics = await this.metricsReader.read(this.client);
			if (!this.disposed && !this.failed) {
				this.postMessage({ type: 'metrics', metrics: this.metricsFormatter.format(metrics) });
			}
		} catch {
			if (!this.disposed && !this.failed) {
				this.postMessage({ type: 'metricsUnavailable' });
			}
		} finally {
			this.metricsRequestPending = false;
		}
	}

	private handleShellClosed(): void {
		if (this.disposed) {
			return;
		}
		this.connected = false;
		this.stopMetricsPolling();
		this.client.end();
		this.postMessage({ type: 'status', status: 'closed', message: 'Connection closed' });
	}

	private handleConnectionFailure(error: Error): void {
		if (this.failed || this.disposed) {
			return;
		}

		this.failed = true;
		this.connected = false;
		this.stopMetricsPolling();
		const reason = error.message === 'All configured authentication methods failed'
			? 'Authentication failed. Check the username and password, and confirm that the server allows password authentication.'
			: error.message;
		this.postMessage({ type: 'status', status: 'error', message: reason });
		this.client.end();
	}

	private postMessage(message: unknown): void {
		if (!this.disposed) {
			void this.panel.webview.postMessage(message);
		}
	}
}

function renderSshTerminal(webview: vscode.Webview, xtermRoot: vscode.Uri, server: SshServer): string {
	const nonce = crypto.randomUUID().replaceAll('-', '');
	const xtermCssUri = webview.asWebviewUri(vscode.Uri.joinPath(xtermRoot, 'xterm.css'));
	const xtermJsUri = webview.asWebviewUri(vscode.Uri.joinPath(xtermRoot, 'xterm.js'));
	const fitAddonJsUri = webview.asWebviewUri(vscode.Uri.joinPath(xtermRoot, 'addon-fit.js'));
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
	<link rel="stylesheet" href="${xtermCssUri}">
	<title>${escapeHtml(server.name)}</title>
	<style>
		:root { color-scheme: light dark; }
		* { box-sizing: border-box; }
		html, body { width: 100%; height: 100%; margin: 0; padding:0; overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
		body { display: grid; grid-template-rows: auto minmax(0, 1fr); }
		.metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); height: 34px; margin: 0 4px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
		.metric { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; padding: 0 10px 0 13px; }
		.metric::before { position: absolute; left: 5px; width: 3px; height: 12px; border-radius: 2px; background: var(--metric-accent); content: ''; }
		.metric:nth-child(1) { --metric-accent: var(--vscode-charts-blue); }
		.metric:nth-child(2) { --metric-accent: var(--vscode-charts-green); }
		.metric:nth-child(3) { --metric-accent: var(--vscode-charts-yellow); }
		.metric:nth-child(4) { --metric-accent: var(--vscode-charts-purple); }
		.metric:last-child { border-right: 0; }
		.metric-label { flex: 0 0 auto; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 600; text-transform: uppercase; }
		.metric-value { min-width: 0; overflow: hidden; color: var(--vscode-foreground); font-family: var(--vscode-editor-font-family); font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
		.terminal-shell { position: relative; min-height: 0; padding: 6px 4px 4px; }
		#terminal { width: 100%; height: 100%; }
		.connection-status { position: absolute; inset: 0; z-index: 2; display: flex; align-items: center; justify-content: center; pointer-events: none; }
		.connection-status[hidden] { display: none; }
		.status-content { display: grid; grid-template-columns: 18px auto; align-items: center; gap: 5px 12px; max-width: min(520px, calc(100% - 32px)); }
		.status-indicator { grid-row: 1 / 3; width: 16px; height: 16px; border: 2px solid color-mix(in srgb, var(--vscode-progressBar-background) 28%, transparent); border-top-color: var(--vscode-progressBar-background); border-radius: 50%; animation: status-spin 0.8s linear infinite; }
		.status-title { color: var(--vscode-foreground); font-size: 13px; font-weight: 500; }
		.status-detail { overflow: hidden; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
		.connection-status.error .status-indicator, .connection-status.closed .status-indicator { border: 0; background: currentColor; animation: none; }
		.connection-status.error { color: var(--vscode-errorForeground); }
		.connection-status.error .status-title { color: var(--vscode-errorForeground); }
		.connection-status.closed { color: var(--vscode-descriptionForeground); }
		@keyframes status-spin { to { transform: rotate(360deg); } }
		@media (max-width: 620px) { .metric { gap: 4px; padding-right: 6px; } .metric-label { font-size: 9px; } .metric-value { font-size: 11px; } }
	</style>
</head>
<body>
	<header class="metrics" aria-label="Remote server metrics">
		<div class="metric"><span class="metric-label">CPU</span><span id="cpuMetric" class="metric-value">--</span></div>
		<div class="metric"><span class="metric-label">Memory</span><span id="memoryMetric" class="metric-value">--</span></div>
		<div class="metric"><span class="metric-label">Disk</span><span id="diskMetric" class="metric-value">--</span></div>
		<div class="metric"><span class="metric-label">Network</span><span id="networkMetric" class="metric-value">--</span></div>
	</header>
	<main class="terminal-shell">
		<div id="connectionStatus" class="connection-status">
			<div class="status-content">
				<span class="status-indicator" aria-hidden="true"></span>
				<span id="statusTitle" class="status-title">Preparing terminal</span>
				<span id="statusDetail" class="status-detail">${escapeHtml(`${server.username}@${server.host}:${server.port}`)}</span>
			</div>
		</div>
		<div id="terminal" aria-label="SSH terminal"></div>
	</main>
	<script nonce="${nonce}" src="${xtermJsUri}"></script>
	<script nonce="${nonce}" src="${fitAddonJsUri}"></script>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const terminalElement = document.getElementById('terminal');
		const statusElement = document.getElementById('connectionStatus');
		const statusTitle = document.getElementById('statusTitle');
		const statusDetail = document.getElementById('statusDetail');
		const metrics = {
			cpu: document.getElementById('cpuMetric'),
			memory: document.getElementById('memoryMetric'),
			disk: document.getElementById('diskMetric'),
			network: document.getElementById('networkMetric')
		};
		const terminal = new Terminal({
			cursorBlink: true,
			fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-font-family'),
			fontSize: Number(getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-font-size').replace('px', '')) || 14,
			theme: terminalTheme(),
			scrollback: 5000
		});
		const fitAddon = new FitAddon.FitAddon();
		terminal.loadAddon(fitAddon);
		terminal.open(terminalElement);
		terminal.onData(data => vscode.postMessage({ type: 'input', data }));
		terminal.onResize(size => vscode.postMessage({ type: 'resize', rows: size.rows, columns: size.cols }));

		const resizeObserver = new ResizeObserver(() => fitTerminal());
		resizeObserver.observe(terminalElement);
		window.addEventListener('message', event => {
			const message = event.data;
			if (message.type === 'output') terminal.write(Uint8Array.from(atob(message.data), character => character.charCodeAt(0)));
			if (message.type === 'status') updateStatus(message.status, message.message);
			if (message.type === 'metrics') updateMetrics(message.metrics);
			if (message.type === 'metricsUnavailable') updateMetrics({ cpu: '--', memory: '--', disk: '--', network: '--' });
		});
		window.addEventListener('focus', () => terminal.focus());
		window.addEventListener('resize', fitTerminal);

		requestAnimationFrame(() => {
			fitTerminal();
			terminal.focus();
			vscode.postMessage({ type: 'ready' });
		});

		function fitTerminal() {
			if (terminalElement.clientWidth > 0 && terminalElement.clientHeight > 0) fitAddon.fit();
		}

		function updateStatus(status, message) {
			statusElement.className = 'connection-status ' + status;
			statusTitle.textContent = status === 'connecting' ? 'Connecting' : status === 'error' ? 'Connection failed' : status === 'closed' ? 'Connection closed' : 'Connected';
			statusDetail.textContent = message;
			statusElement.hidden = status === 'connected';
		}

		function updateMetrics(values) {
			metrics.cpu.textContent = values.cpu;
			metrics.memory.textContent = values.memory;
			metrics.disk.textContent = values.disk;
			metrics.network.textContent = values.network;
		}

		function terminalTheme() {
			const style = getComputedStyle(document.documentElement);
			return {
				background: style.getPropertyValue('--vscode-editor-background').trim(),
				foreground: style.getPropertyValue('--vscode-terminal-foreground').trim() || style.getPropertyValue('--vscode-editor-foreground').trim(),
				cursor: style.getPropertyValue('--vscode-terminalCursor-foreground').trim(),
				selectionBackground: style.getPropertyValue('--vscode-terminal-selectionBackground').trim()
			};
		}
	</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#039;');
}