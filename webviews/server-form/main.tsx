import { StrictMode, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { BasicInformation } from './basic-information';
import { ContainerFields } from './container-fields';
import { FormHeader } from './form-header';
import { NetworkFields } from './network-fields';
import type { FormValues, InitialData } from './types';
import '../styles.css';

interface VsCodeApi {
	postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const initialData = JSON.parse(document.getElementById('server-form-data')!.textContent!) as InitialData;
const vscode = acquireVsCodeApi();

function ServerFormApp() {
	const { serverType, server, credentials, isEditing } = initialData;
	const initialAuthType = server?.type === 'ssh' ? server.authType ?? 'password' : 'password';
	const [values, setValues] = useState<FormValues>({
		name: server?.name ?? '',
		group: server?.group ?? '',
		host: server?.host ?? '',
		port: String(server?.port ?? (serverType === 'mysql' ? 3306 : 22)),
		username: server?.username ?? '',
		authType: initialAuthType,
		proxyCommand: server?.proxyCommand ?? '',
		password: credentials.password ?? '',
		privateKey: credentials.privateKey ?? '',
		passphrase: credentials.passphrase ?? '',
		database: server?.database ?? '',
		runtime: server?.runtime ?? 'docker',
		executablePath: server?.executablePath ?? 'docker',
	});
	const [error, setError] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const [visibleSecrets, setVisibleSecrets] = useState<Record<string, boolean>>({});

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data;
			if (message.type === 'executableSelected' && typeof message.path === 'string') {
				setValues(current => ({ ...current, executablePath: message.path }));
				return;
			}
			if (message.type === 'privateKeySelected' && typeof message.contents === 'string') {
				setValues(current => ({ ...current, privateKey: message.contents }));
				return;
			}
			if (message.type === 'error') {
				setError(typeof message.message === 'string' ? message.message : 'Could not save the server.');
				setSubmitting(false);
			}
		};
		window.addEventListener('message', handleMessage);
		return () => window.removeEventListener('message', handleMessage);
	}, []);

	const setValue = (name: keyof typeof values, value: string) => {
		setValues(current => ({ ...current, [name]: value }));
		setError('');
	};
	const authChanged = values.authType !== initialAuthType;
	const credentialRequired = !isEditing || authChanged;
	const hasRequiredCredential = serverType === 'container'
		|| (serverType === 'ssh' && values.authType === 'privateKey'
			? !credentialRequired || values.privateKey.trim() !== ''
			: !credentialRequired || values.password !== '');
	const networkFieldsValid = serverType === 'container' || (
		values.host.trim() !== ''
		&& values.username.trim() !== ''
		&& Number.isInteger(Number(values.port))
		&& Number(values.port) >= 1
		&& Number(values.port) <= 65535
	);
	const formValid = values.name.trim() !== ''
		&& networkFieldsValid
		&& hasRequiredCredential
		&& (serverType !== 'mysql' || values.database.trim() !== '')
		&& (serverType !== 'container' || values.executablePath.trim() !== '');

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!formValid || submitting) {
			return;
		}
		setError('');
		setSubmitting(true);
		vscode.postMessage({ type: 'save', ...values });
	};

	return (
		<form className="min-h-screen bg-editor-background font-vscode text-foreground" onSubmit={submit}>
			<FormHeader title={initialData.title} description={initialData.description} formValid={formValid} submitting={submitting} />
			<main className="mx-auto w-full max-w-3xl px-6 py-8 max-sm:px-4 max-sm:py-6">
				<BasicInformation serverType={serverType} groups={initialData.groups} values={values} setValue={setValue} />
				<section className="border-t border-panel-border pt-6" aria-labelledby="connection-heading">
					<h2 className="mb-4 text-sm font-semibold" id="connection-heading">Connection details</h2>
					<div className="grid gap-4">
						{serverType === 'container'
							? <ContainerFields values={values} setValue={setValue} onSelectExecutable={() => { setError(''); vscode.postMessage({ type: 'selectExecutable' }); }} />
							: <NetworkFields serverType={serverType} values={values} setValue={setValue} credentialRequired={credentialRequired} visibleSecrets={visibleSecrets} setVisibleSecrets={setVisibleSecrets} onSelectPrivateKey={() => { setError(''); vscode.postMessage({ type: 'selectPrivateKey' }); }} />}
					</div>
				</section>
				{error && <div className="mt-6 flex items-start gap-2 border-t border-panel-border pt-4 leading-normal text-error-foreground" role="alert"><span className="codicon codicon-error mt-0.5" aria-hidden="true" />{error}</div>}
			</main>
		</form>
	);
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<ServerFormApp />
	</StrictMode>,
);