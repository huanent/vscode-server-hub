import { StrictMode, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './server-form.css';

type ServerType = 'ssh' | 'mysql' | 'container';
type AuthType = 'password' | 'privateKey';
type Runtime = 'docker' | 'podman' | 'apple';

interface Server {
	type: ServerType;
	name: string;
	group: string;
	host?: string;
	port?: number;
	username?: string;
	authType?: AuthType;
	proxyCommand?: string;
	database?: string;
	runtime?: Runtime;
	executablePath?: string;
}

interface InitialData {
	serverType: ServerType;
	groups: string[];
	server?: Server;
	credentials: {
		password?: string;
		privateKey?: string;
		passphrase?: string;
	};
	isEditing: boolean;
	title: string;
	description: string;
}

interface VsCodeApi {
	postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const initialData = JSON.parse(document.getElementById('server-form-data')!.textContent!) as InitialData;
const vscode = acquireVsCodeApi();
const runtimeDefaults: Record<Runtime, string> = {
	docker: 'docker',
	podman: 'podman',
	apple: '/opt/homebrew/bin/container',
};

function ServerFormApp() {
	const { serverType, server, credentials, isEditing } = initialData;
	const initialAuthType = server?.type === 'ssh' ? server.authType ?? 'password' : 'password';
	const [values, setValues] = useState({
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
		<form onSubmit={submit}>
			<header className="topbar">
				<div className="topbar-content">
					<Field label="Name" required>
						<input autoFocus autoComplete="off" required placeholder="Production" value={values.name} onChange={event => setValue('name', event.target.value)} />
					</Field>
					<Field className="group-field" label="Group">
						<input autoComplete="off" list="server-groups" placeholder="No group" value={values.group} onChange={event => setValue('group', event.target.value)} />
						<datalist id="server-groups">{initialData.groups.map(group => <option key={group} value={group} />)}</datalist>
					</Field>
					<div className="save-area"><button type="submit" disabled={!formValid || submitting}>Save</button></div>
				</div>
			</header>
			<main className="content">
				<header className="heading">
					<h1>{initialData.title}</h1>
					<p>{initialData.description}</p>
				</header>
				<section className="section" aria-labelledby="connection-heading">
					<h2 className="section-title" id="connection-heading">Connection details</h2>
					<div className="fields">
						{serverType === 'container'
							? <ContainerFields values={values} setValue={setValue} setError={setError} />
							: <NetworkFields values={values} setValue={setValue} credentialRequired={credentialRequired} visibleSecrets={visibleSecrets} setVisibleSecrets={setVisibleSecrets} setError={setError} />}
					</div>
				</section>
				<div className="error" role="alert">{error}</div>
			</main>
		</form>
	);
}

function ContainerFields({ values, setValue, setError }: FormProps & { setError(value: string): void }) {
	const selectRuntime = (runtime: Runtime) => {
		const currentDefault = runtimeDefaults[values.runtime as Runtime];
		setValue('runtime', runtime);
		if (!values.executablePath || values.executablePath === currentDefault) {
			setValue('executablePath', runtimeDefaults[runtime]);
		}
	};
	return <>
		<SegmentedControl label="Container runtime" value={values.runtime} options={[['docker', 'Docker'], ['podman', 'Podman'], ['apple', 'Apple']]} onChange={value => selectRuntime(value as Runtime)} />
		<Field label="Executable" required action={<FileButton label="Select file" onClick={() => { setError(''); vscode.postMessage({ type: 'selectExecutable' }); }} />}>
			<input autoComplete="off" required placeholder="docker" value={values.executablePath} onChange={event => setValue('executablePath', event.target.value)} />
		</Field>
	</>;
}

function NetworkFields({ values, setValue, credentialRequired, visibleSecrets, setVisibleSecrets, setError }: FormProps & {
	credentialRequired: boolean;
	visibleSecrets: Record<string, boolean>;
	setVisibleSecrets(value: Record<string, boolean>): void;
	setError(value: string): void;
}) {
	const usesPrivateKey = values.authType === 'privateKey';
	return <>
		<div className="connection">
			<Field label="Host" required><input autoComplete="off" required placeholder="server.example.com" value={values.host} onChange={event => setValue('host', event.target.value)} /></Field>
			<Field label="Port" required><input type="number" min="1" max="65535" required value={values.port} onChange={event => setValue('port', event.target.value)} /></Field>
		</div>
		<Field label="Username" required><input autoComplete="username" required placeholder="root" value={values.username} onChange={event => setValue('username', event.target.value)} /></Field>
		{initialData.serverType === 'ssh' && <Field label="Proxy command"><input autoComplete="off" spellCheck={false} placeholder="cloudflared access tcp --hostname example.com" value={values.proxyCommand} onChange={event => setValue('proxyCommand', event.target.value)} /></Field>}
		{initialData.serverType === 'mysql'
			? <Field label="Database" required><input autoComplete="off" required placeholder="app" value={values.database} onChange={event => setValue('database', event.target.value)} /></Field>
			: <SegmentedControl label="Authentication method" value={values.authType} options={[['password', 'Password'], ['privateKey', 'Private key']]} onChange={value => setValue('authType', value)} />}
		{!usesPrivateKey && <Field label="Password" required={credentialRequired}><SecretInput name="password" value={values.password} visible={visibleSecrets.password} setValue={setValue} toggle={() => setVisibleSecrets({ ...visibleSecrets, password: !visibleSecrets.password })} /></Field>}
		{initialData.serverType === 'ssh' && usesPrivateKey && <div className="fields">
			<Field label="Private key" required={credentialRequired} action={<FileButton label="Select file" onClick={() => { setError(''); vscode.postMessage({ type: 'selectPrivateKey' }); }} />}>
				<textarea required={credentialRequired} spellCheck={false} placeholder="Paste the PEM or OpenSSH private key" value={values.privateKey} onChange={event => setValue('privateKey', event.target.value)} />
			</Field>
			<Field label="Key passphrase"><SecretInput name="passphrase" value={values.passphrase} visible={visibleSecrets.passphrase} setValue={setValue} toggle={() => setVisibleSecrets({ ...visibleSecrets, passphrase: !visibleSecrets.passphrase })} /></Field>
		</div>}
	</>;
}

type FormValues = ReturnType<typeof createEmptyValues>;
function createEmptyValues() {
	return { name: '', group: '', host: '', port: '', username: '', authType: 'password', proxyCommand: '', password: '', privateKey: '', passphrase: '', database: '', runtime: 'docker', executablePath: '' };
}
interface FormProps { values: FormValues; setValue(name: keyof FormValues, value: string): void; }

function Field({ label, required, action, className = '', children }: { label: string; required?: boolean; action?: ReactNode; className?: string; children: ReactNode }) {
	return <label className={`field ${className}`}>
		<span className="field-heading"><span className="field-label">{label}{required && <span className="required" aria-hidden="true"> *</span>}</span>{action}</span>
		{children}
	</label>;
}

function SegmentedControl({ label, value, options, onChange }: { label: string; value: string; options: string[][]; onChange(value: string): void }) {
	return <div className="field"><div className="auth-tabs" role="tablist" aria-label={label}>{options.map(([option, text]) => <button key={option} className="auth-tab" type="button" role="tab" aria-selected={value === option} tabIndex={value === option ? 0 : -1} onClick={() => onChange(option)}>{text}</button>)}</div></div>;
}

function FileButton({ label, onClick }: { label: string; onClick(): void }) {
	return <button className="file-select" type="button" onClick={onClick}><span className="codicon codicon-folder-opened" aria-hidden="true" />{label}</button>;
}

function SecretInput({ name, value, visible, setValue, toggle }: { name: 'password' | 'passphrase'; value: string; visible?: boolean; setValue(name: keyof FormValues, value: string): void; toggle(): void }) {
	const label = visible ? 'Hide value' : 'Show value';
	return <span className="password-control">
		<input type={visible ? 'text' : 'password'} autoComplete={name === 'password' ? 'current-password' : 'off'} value={value} onChange={event => setValue(name, event.target.value)} />
		<button className={`password-toggle codicon ${visible ? 'codicon-eye-closed' : 'codicon-eye'}`} type="button" title={label} aria-label={label} onClick={toggle} />
	</span>;
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<ServerFormApp />
	</StrictMode>,
);