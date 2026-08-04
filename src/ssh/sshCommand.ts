import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { Client } from 'ssh2';
import { SshServer } from '../servers/server';
import { ServerCredentials } from '../servers/serverStore';

export function executeSshCommand(
	server: SshServer,
	credentials: ServerCredentials,
	command: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const client = new Client();
		const proxyProcess = server.proxyCommand ? spawn(server.proxyCommand, {
			shell: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		}) : undefined;
		let settled = false;
		let proxyError = '';

		const finish = (error?: Error, output = '') => {
			if (settled) {
				return;
			}
			settled = true;
			client.end();
			proxyProcess?.kill();
			if (error) {
				reject(error);
			} else {
				resolve(output.trim());
			}
		};

		if (proxyProcess) {
			proxyProcess.stderr.setEncoding('utf8');
			proxyProcess.stderr.on('data', data => {
				proxyError = (proxyError + data).slice(-4000);
			});
			proxyProcess.on('error', finish);
			proxyProcess.on('exit', code => {
				if (!settled && code !== null && code !== 0) {
					finish(new Error(proxyError.trim() || `Proxy command exited with code ${code}.`));
				}
			});
		}

		client
			.on('keyboard-interactive', (_name, _instructions, _language, prompts, respond) => {
				respond(prompts.map(() => credentials.password ?? ''));
			})
			.on('ready', () => {
				client.exec(command, (error, stream) => {
					if (error) {
						finish(error);
						return;
					}
					let stdout = '';
					let stderr = '';
					stream.setEncoding('utf8');
					stream.stderr.setEncoding('utf8');
					stream.on('data', (data: Buffer | string) => stdout += data.toString());
					stream.stderr.on('data', data => stderr += data);
					stream.on('close', (code: number | undefined) => {
						if (code && code !== 0) {
							finish(new Error(stderr.trim() || `Remote command exited with code ${code}.`));
							return;
						}
						finish(undefined, stdout);
					});
				});
			})
			.on('error', finish)
			.connect({
				host: server.host,
				port: server.port,
				username: server.username,
				...(proxyProcess ? { sock: Duplex.from({ readable: proxyProcess.stdout, writable: proxyProcess.stdin }) } : {}),
				...(server.authType === 'privateKey'
					? { privateKey: credentials.privateKey, passphrase: credentials.passphrase }
					: { password: credentials.password, tryKeyboard: true }),
				readyTimeout: 15_000,
			});
	});
}