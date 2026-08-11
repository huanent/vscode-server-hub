import { Container, Database, FolderOpen, KeyRound, Plus, Save, Server, Trash2 } from '../../components/icons';
import { FieldLabel, IconButton, PageHeading, PrimaryButton, SelectInput, TextArea, TextInput } from '../../components/ui';
import { PasswordField } from './components/PasswordField';
import { SegmentedControl } from './components/SegmentedControl';
import { useServerForm } from './hooks/useServerForm';

export function ServerFormApp() {
	const form = useServerForm();
	if (!form.model) {
		return <main className="grid min-h-screen place-items-center text-sm text-(--vscode-descriptionForeground)">Loading...</main>;
	}

	const { model, values } = form;
	const editing = Boolean(model.server);
	const typeLabel = model.serverType === 'mysql' ? 'MySQL' : model.serverType === 'container' ? 'Container' : 'SSH';
	const title = `${editing ? 'Edit' : 'Add'} ${typeLabel} Server`;
	const description = model.serverType === 'container'
		? 'Configure Docker, Podman, or Apple Container locally or through SSH.'
		: `Configure the ${typeLabel} connection. Credentials remain encrypted on this device.`;
	const heading = model.serverType === 'mysql'
		? <Database size={22} />
		: model.serverType === 'container' ? <Container size={22} /> : <Server size={22} />;
	const manualContainerSsh = model.serverType === 'container' && values.connectionType === 'ssh' && !values.sshServerId;
	const usesAuthentication = model.serverType === 'ssh' || model.serverType === 'mysql' || manualContainerSsh;

	return (
		<form className="min-h-screen" onSubmit={event => { event.preventDefault(); form.save(); }}>
			<header className="sticky top-0 z-10 border-b border-(--vscode-panel-border) bg-(--vscode-editor-background) px-5 py-3.5">
				<div className="mx-auto grid max-w-205 grid-cols-[minmax(160px,1.25fr)_minmax(140px,1fr)_auto] items-end gap-3 max-[680px]:grid-cols-[minmax(0,1fr)_auto]">
					<Field label="Name" required>
						<TextInput autoFocus required placeholder="Production" value={values.name} onChange={event => form.update('name', event.target.value)} />
					</Field>
					<Field label="Group" className="max-[680px]:col-start-1 max-[680px]:row-start-2">
						<TextInput list="server-groups" placeholder="No group" value={values.group} onChange={event => form.update('group', event.target.value)} />
						<datalist id="server-groups">{model.groups.map(group => <option key={group} value={group} />)}</datalist>
					</Field>
					<PrimaryButton className="max-[680px]:col-start-2 max-[680px]:row-span-2 max-[680px]:row-start-1 max-[680px]:self-start" type="submit" disabled={form.saving}>
						<Save size={15} />{form.saving ? 'Saving...' : 'Save'}
					</PrimaryButton>
				</div>
			</header>

			<main className="mx-auto w-[min(640px,calc(100%-44px))] py-8.5 pb-14 max-[680px]:w-[calc(100%-28px)] max-[680px]:pt-7">
				<PageHeading icon={heading} title={title} description={description} accentClassName={model.serverType === 'mysql' ? 'text-(--vscode-charts-yellow)' : model.serverType === 'container' ? 'text-(--vscode-charts-green)' : 'text-(--vscode-charts-blue)'} />
				<section className="border-t border-(--vscode-panel-border) pt-4.5" aria-labelledby="connection-heading">
					<h2 className="mt-0 mb-3.5 text-sm font-semibold" id="connection-heading">Connection details</h2>
					<div className="grid gap-3.5">
						{model.serverType === 'container' ? <ContainerFields form={form} /> : <NetworkFields form={form} />}
						{usesAuthentication && <AuthenticationFields form={form} />}
					</div>
				</section>
				{model.serverType === 'ssh' && <CommandFields form={form} />}
				{form.error && <div className="mt-4 border-l-[3px] border-(--vscode-errorForeground) bg-(--vscode-inputValidation-errorBackground) px-3 py-2.5 text-(--vscode-errorForeground)" role="alert">{form.error}</div>}
			</main>
		</form>
	);
}

type FormState = ReturnType<typeof useServerForm>;

function NetworkFields({ form }: { form: FormState }) {
	const { model, values } = form;
	return <>
		<div className="grid grid-cols-[minmax(0,1fr)_112px] gap-3 max-[440px]:grid-cols-1">
			<Field label="Host" required><TextInput required placeholder="server.example.com" value={values.host} onChange={event => form.update('host', event.target.value)} /></Field>
			<Field label="Port" required><TextInput required type="number" min={1} max={65535} value={values.port} onChange={event => form.update('port', event.target.value)} /></Field>
		</div>
		<Field label="Username" required><TextInput required autoComplete="username" placeholder="root" value={values.username} onChange={event => form.update('username', event.target.value)} /></Field>
		{model!.serverType === 'ssh' && <Field label="Proxy command"><TextInput spellCheck={false} placeholder="cloudflared access tcp --hostname example.com" value={values.proxyCommand} onChange={event => form.update('proxyCommand', event.target.value)} /></Field>}
		{model!.serverType === 'mysql' && <Field label="Database" required><TextInput required placeholder="app" value={values.database} onChange={event => form.update('database', event.target.value)} /></Field>}
	</>;
}

function ContainerFields({ form }: { form: FormState }) {
	const { model, values } = form;
	const remote = values.connectionType === 'ssh';
	const manual = remote && !values.sshServerId;
	const runtimeDefaults = { docker: 'docker', podman: 'podman', apple: '/opt/homebrew/bin/container' } as const;
	return <>
		<SegmentedControl label="Container connection" value={values.connectionType} options={[{ value: 'local', label: 'Local' }, { value: 'ssh', label: 'SSH' }]} onChange={value => form.update('connectionType', value)} />
		<SegmentedControl label="Container runtime" value={values.runtime} options={[{ value: 'docker', label: 'Docker' }, { value: 'podman', label: 'Podman' }, { value: 'apple', label: 'Apple' }]} onChange={value => { form.update('runtime', value); form.update('executablePath', runtimeDefaults[value]); }} />
		<Field label="Executable" required>
			<span className="flex">
				<TextInput className="min-w-0 border-r-0" required placeholder="docker" value={values.executablePath} onChange={event => form.update('executablePath', event.target.value)} />
				<IconButton type="button" title="Select executable" aria-label="Select executable" onClick={form.selectExecutable}><FolderOpen size={16} /></IconButton>
			</span>
		</Field>
		{remote && <Field label="SSH configuration">
			<SelectInput value={values.sshServerId} onChange={event => form.update('sshServerId', event.target.value)}>
				<option value="">Manual configuration</option>
				{model!.sshServers.map(server => <option key={server.id} value={server.id}>{server.name} ({server.username}@{server.host})</option>)}
			</SelectInput>
		</Field>}
		{manual && <>
			<div className="grid grid-cols-[minmax(0,1fr)_112px] gap-3 max-[440px]:grid-cols-1">
				<Field label="Host" required><TextInput required placeholder="server.example.com" value={values.host} onChange={event => form.update('host', event.target.value)} /></Field>
				<Field label="Port" required><TextInput required type="number" min={1} max={65535} value={values.port} onChange={event => form.update('port', event.target.value)} /></Field>
			</div>
			<Field label="Username" required><TextInput required placeholder="root" value={values.username} onChange={event => form.update('username', event.target.value)} /></Field>
			<Field label="Proxy command"><TextInput spellCheck={false} placeholder="Optional" value={values.proxyCommand} onChange={event => form.update('proxyCommand', event.target.value)} /></Field>
		</>}
	</>;
}

function AuthenticationFields({ form }: { form: FormState }) {
	const { model, values } = form;
	const supportsPrivateKey = model!.serverType !== 'mysql';
	const credentialRequired = !model!.server;
	return <>
		{supportsPrivateKey && <SegmentedControl label="Authentication method" value={values.authType} options={[{ value: 'password', label: 'Password' }, { value: 'privateKey', label: 'Private key' }]} onChange={value => form.update('authType', value)} />}
		{values.authType === 'password' || !supportsPrivateKey
			? <PasswordField label="Password" required={credentialRequired} value={values.password} onChange={value => form.update('password', value)} />
			: <>
				<Field label="Private key" required={credentialRequired}>
					<span className="flex">
						<TextArea className="min-w-0 border-r-0" required={credentialRequired} spellCheck={false} placeholder="Paste the PEM or OpenSSH private key" value={values.privateKey} onChange={event => form.update('privateKey', event.target.value)} />
						<IconButton className="h-auto self-stretch" type="button" title="Select private key" aria-label="Select private key" onClick={form.selectPrivateKey}><KeyRound size={16} /></IconButton>
					</span>
				</Field>
				<PasswordField label="Key passphrase" placeholder="Optional" value={values.passphrase} onChange={value => form.update('passphrase', value)} />
			</>}
	</>;
}

function CommandFields({ form }: { form: FormState }) {
	const commands = form.values.commands;
	const updateCommand = (index: number, key: 'name' | 'value', value: string) => {
		form.update('commands', commands.map((command, commandIndex) => commandIndex === index ? { ...command, [key]: value } : command));
	};
	return (
		<section className="mt-7 border-t border-(--vscode-panel-border) pt-4.5" aria-labelledby="commands-heading">
			<div className="mb-3.5 flex items-center justify-between gap-3">
				<h2 className="m-0 text-sm font-semibold" id="commands-heading">Commands</h2>
				<IconButton type="button" title="Add command" aria-label="Add command" onClick={() => form.update('commands', [...commands, { name: '', value: '' }])}><Plus size={16} /></IconButton>
			</div>
			<div className="grid gap-3">
				{commands.map((command, index) => (
					<div className="grid grid-cols-[minmax(120px,0.7fr)_minmax(0,1.3fr)_34px] items-end gap-2 max-[520px]:grid-cols-[minmax(0,1fr)_34px]" key={index}>
						<Field label="Name" required className="max-[520px]:col-span-2"><TextInput required placeholder="Restart service" value={command.name} onChange={event => updateCommand(index, 'name', event.target.value)} /></Field>
						<Field label="Command" required><TextInput required spellCheck={false} placeholder="sudo systemctl restart app" value={command.value} onChange={event => updateCommand(index, 'value', event.target.value)} /></Field>
						<IconButton type="button" title="Remove command" aria-label="Remove command" onClick={() => form.update('commands', commands.filter((_, commandIndex) => commandIndex !== index))}><Trash2 size={16} /></IconButton>
					</div>
				))}
			</div>
		</section>
	);
}

function Field({ label, required, className = '', children }: { label: string; required?: boolean; className?: string; children: React.ReactNode }) {
	return <label className={`block min-w-0 ${className}`}><FieldLabel>{label}{required && <span className="ml-1 text-(--vscode-errorForeground)">*</span>}</FieldLabel>{children}</label>;
}