import * as vscode from 'vscode';
import { Client, ClientChannel } from 'ssh2';
import { RemoteMetricsReader, RemoteMetricsStatusFormatter, collapseWhitespace } from './remoteMetrics';
import { SshServer } from './server';

const metricsRefreshIntervalMs = 5000;

export function openSshTerminal(server: SshServer, password: string): void {
	const terminal = vscode.window.createTerminal({
		name: server.name,
		pty: new SshTerminalPseudoterminal(server, password),
		location: vscode.TerminalLocation.Editor,
		iconPath: new vscode.ThemeIcon('remote'),
	});
	terminal.show();
}

class SshTerminalPseudoterminal implements vscode.Pseudoterminal {
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	private readonly closeEmitter = new vscode.EventEmitter<number>();
	private readonly metricsReader = new RemoteMetricsReader();
	private readonly metricsFormatter = new RemoteMetricsStatusFormatter();
	private client: Client | undefined;
	private shellStream: ClientChannel | undefined;
	private dimensions: vscode.TerminalDimensions | undefined;
	private metricsTimer: NodeJS.Timeout | undefined;
	private metricsRequestPending = false;
	private failed = false;
	private closed = false;
	private viewportInitialized = false;

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
			.on('ready', () => this.openRemoteShell(client))
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

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.stopMetricsPolling();
		this.shellStream?.close();
		this.client?.end();
	}

	handleInput(data: string): void {
		this.shellStream?.write(data);
	}

	setDimensions(dimensions: vscode.TerminalDimensions): void {
		this.dimensions = dimensions;
		this.shellStream?.setWindow(dimensions.rows, dimensions.columns, 0, 0);
		this.configureTerminalViewport();
	}

	private openRemoteShell(client: Client): void {
		client.shell(this.getShellOptions(), (error, stream) => {
			if (error) {
				this.handleConnectionFailure(error);
				return;
			}

			this.shellStream = stream;
			stream.on('data', (data: Buffer) => this.writeEmitter.fire(data.toString()));
			stream.stderr.on('data', (data: Buffer) => this.writeEmitter.fire(data.toString()));
			stream.on('close', () => this.handleShellClosed());
			this.configureTerminalViewport();
			this.startMetricsPolling(client);
		});
	}

	private getShellOptions(): false | { term: string; rows: number; cols: number } {
		if (!this.dimensions) {
			return false;
		}
		return {
			term: 'xterm-256color',
			rows: this.dimensions.rows,
			cols: this.dimensions.columns,
		};
	}

	private configureTerminalViewport(): void {
		if (!this.dimensions) {
			return;
		}

		const clearScreen = this.viewportInitialized ? '' : '\u001b[2J';
		this.viewportInitialized = true;
		this.writeEmitter.fire(`\u001b[r${clearScreen}\u001b[H${this.buildStatusLine('Loading metrics...')}\u001b[2;${this.dimensions.rows}r\u001b[2;1H`);
	}

	private startMetricsPolling(client: Client): void {
		this.stopMetricsPolling();
		this.metricsFormatter.reset();
		void this.refreshMetrics(client);
		this.metricsTimer = setInterval(() => void this.refreshMetrics(client), metricsRefreshIntervalMs);
	}

	private stopMetricsPolling(): void {
		if (this.metricsTimer) {
			clearInterval(this.metricsTimer);
			this.metricsTimer = undefined;
		}
		this.metricsFormatter.reset();
	}

	private async refreshMetrics(client: Client): Promise<void> {
		if (this.closed || this.failed || this.metricsRequestPending) {
			return;
		}

		this.metricsRequestPending = true;
		try {
			const metrics = await this.metricsReader.read(client);
			if (!this.closed && !this.failed) {
				this.renderStatusLine(this.metricsFormatter.format(metrics));
			}
		} catch {
			if (!this.closed && !this.failed) {
				this.renderStatusLine('Metrics unavailable');
			}
		} finally {
			this.metricsRequestPending = false;
		}
	}

	private renderStatusLine(content: string): void {
		this.writeEmitter.fire(`\u001b7\u001b[1;1H${this.buildStatusLine(content)}\u001b8`);
	}

	private buildStatusLine(content: string): string {
		const columns = this.dimensions?.columns ?? 120;
		const normalizedContent = collapseWhitespace(content);
		const visibleContent = normalizedContent.slice(0, Math.max(columns - 1, 1)).padEnd(columns, ' ');
		return `\u001b[7m${visibleContent}\u001b[0m`;
	}

	private handleShellClosed(): void {
		this.stopMetricsPolling();
		this.client?.end();
		this.closed = true;
		this.closeEmitter.fire(0);
	}

	private handleConnectionFailure(error: Error): void {
		if (this.failed) {
			return;
		}

		this.failed = true;
		this.stopMetricsPolling();
		const reason = error.message === 'All configured authentication methods failed'
			? 'Authentication failed. Check the username and password, and confirm that the server allows password authentication.'
			: error.message;
		this.writeEmitter.fire(`\r\nCould not connect to “${this.server.name}”: ${reason}\r\n`);
		this.writeEmitter.fire('Connection terminal is kept open so you can review this error.\r\n');
		this.client?.end();
	}
}