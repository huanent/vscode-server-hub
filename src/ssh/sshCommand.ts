import { SshServer } from '../servers/server';
import { ServerCredentials } from '../servers/serverStore';
import { connectSshClient, SshConnection } from './sshConnection';

export function executeSshCommand(
	server: SshServer,
	credentials: ServerCredentials,
	command: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let connection: SshConnection | undefined;

		const finish = (error?: Error, output = '') => {
			if (settled) {
				return;
			}
			settled = true;
			connection?.dispose();
			if (error) {
				reject(error);
			} else {
				resolve(output.trim());
			}
		};

		connectSshClient(server, credentials, nextConnection => {
			connection = nextConnection;
			nextConnection.client.exec(command, (error, stream) => {
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
		}, finish);
	});
}