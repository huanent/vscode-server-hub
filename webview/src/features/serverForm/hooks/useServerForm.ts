import { useEffect, useState } from 'react';
import { vscode } from '../../../vscodeApi';
import type { ServerFormExtensionMessage, ServerFormModel, ServerFormValues } from '../types';

const emptyValues: ServerFormValues = {
	name: '', group: '', host: '', port: '22', username: '', authType: 'password', proxyCommand: '',
	password: '', privateKey: '', passphrase: '', database: '', runtime: 'docker', executablePath: 'docker',
	connectionType: 'local', sshServerId: '', commands: [],
};

export function useServerForm() {
	const [model, setModel] = useState<ServerFormModel>();
	const [values, setValues] = useState(emptyValues);
	const [error, setError] = useState('');
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		const handleMessage = (event: MessageEvent<ServerFormExtensionMessage>) => {
			const message = event.data;
			switch (message.type) {
				case 'initialize': {
					const nextModel = message.model;
					const server = nextModel.server;
					const container = server?.type === 'container' ? server : undefined;
					setModel(nextModel);
					setValues({
						...emptyValues,
						name: server?.name ?? '',
						group: server?.group ?? '',
						host: server && 'host' in server ? server.host ?? '' : '',
						port: String(server && 'port' in server ? server.port ?? 22 : nextModel.serverType === 'mysql' ? 3306 : 22),
						username: server && 'username' in server ? server.username ?? '' : '',
						authType: server && 'authType' in server ? server.authType ?? 'password' : 'password',
						proxyCommand: server && 'proxyCommand' in server ? server.proxyCommand ?? '' : '',
						commands: server?.type === 'ssh' ? server.commands : [],
						password: nextModel.credentials.password ?? '',
						privateKey: nextModel.credentials.privateKey ?? '',
						passphrase: nextModel.credentials.passphrase ?? '',
						database: server?.type === 'mysql' ? server.database : '',
						runtime: container?.runtime ?? 'docker',
						executablePath: container?.executablePath ?? 'docker',
						connectionType: container?.connectionType ?? 'local',
						sshServerId: container?.sshServerId ?? '',
					});
					break;
				}
				case 'executableSelected':
					setValues(current => ({ ...current, executablePath: message.path }));
					break;
				case 'privateKeySelected':
					setValues(current => ({ ...current, privateKey: message.contents }));
					break;
				case 'error':
					setError(message.message);
					setSaving(false);
					break;
			}
		};
		window.addEventListener('message', handleMessage);
		vscode.postMessage({ type: 'ready' });
		return () => window.removeEventListener('message', handleMessage);
	}, []);

	const update = <Key extends keyof ServerFormValues>(key: Key, value: ServerFormValues[Key]) => {
		setError('');
		setValues(current => ({ ...current, [key]: value }));
	};
	const save = () => {
		setError('');
		setSaving(true);
		vscode.postMessage({ type: 'save', ...values });
	};

	return {
		model, values, error, saving, update, save,
		selectExecutable: () => vscode.postMessage({ type: 'selectExecutable' }),
		selectPrivateKey: () => vscode.postMessage({ type: 'selectPrivateKey' }),
	};
}