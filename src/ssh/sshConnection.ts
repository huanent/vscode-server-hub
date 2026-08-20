import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { Client, ConnectConfig } from 'ssh2';
import { SshServer } from '../servers/server';
import { ServerCredentials } from '../servers/serverStore';

export interface SshConnection {
	client: Client;
	dispose: () => void;
}

export function connectSshClient(
	server: SshServer,
	credentials: ServerCredentials,
	onReady: (connection: SshConnection) => void,
	onError: (error: Error) => void,
): void {
	const client = new Client();
	let proxyClient: Client | undefined;
	let proxyProcess: ChildProcessWithoutNullStreams | undefined;
	let disposed = false;
	let failed = false;

	const dispose = () => {
		if (disposed) {
			return;
		}
		disposed = true;
		client.end();
		proxyClient?.end();
		if (proxyProcess && proxyProcess.exitCode === null && proxyProcess.signalCode === null) {
			proxyProcess.kill();
		}
	};
	const fail = (error: Error) => {
		if (failed || disposed) {
			return;
		}
		failed = true;
		dispose();
		onError(error);
	};
	const connectTarget = (sock?: Duplex) => {
		client
			.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
				finish(prompts.map(() => credentials.password ?? ''));
			})
			.on('ready', () => onReady({ client, dispose }))
			.on('error', fail)
			.connect({
				...connectionConfig(server, credentials),
				...(sock ? { sock } : {}),
			});
	};

	if (server.proxy) {
		proxyClient = new Client();
		proxyClient
			.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
				finish(prompts.map(() => credentials.proxyPassword ?? ''));
			})
			.on('ready', () => {
				proxyClient!.forwardOut('127.0.0.1', 0, server.host, server.port, (error, stream) => {
					if (error) {
						fail(error);
						return;
					}
					connectTarget(stream);
				});
			})
			.on('error', fail)
			.connect(connectionConfig(server.proxy, {
				password: credentials.proxyPassword,
				privateKey: credentials.proxyPrivateKey,
				passphrase: credentials.proxyPassphrase,
			}));
		return;
	}

	if (server.proxyCommand) {
		proxyProcess = spawn(server.proxyCommand, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
		let stderr = '';
		proxyProcess.stderr.setEncoding('utf8');
		proxyProcess.stderr.on('data', data => stderr = (stderr + data).slice(-4000));
		proxyProcess.on('error', fail);
		proxyProcess.on('exit', (code, signal) => {
			if (!disposed && !failed && code !== 0) {
				fail(new Error(stderr.trim() || `Proxy command exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`));
			}
		});
		connectTarget(Duplex.from({ readable: proxyProcess.stdout, writable: proxyProcess.stdin }));
		return;
	}

	connectTarget();
}

function connectionConfig(
	server: Pick<SshServer, 'host' | 'port' | 'username' | 'authType'>,
	credentials: ServerCredentials,
): ConnectConfig {
	return {
		host: server.host,
		port: server.port,
		username: server.username,
		...(server.authType === 'privateKey'
			? { privateKey: credentials.privateKey, passphrase: credentials.passphrase }
			: { password: credentials.password, tryKeyboard: true }),
		readyTimeout: 15_000,
	};
}