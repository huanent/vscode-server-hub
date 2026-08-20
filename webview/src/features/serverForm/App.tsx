import { useState } from 'react';
import { FolderOpen, KeyRound, Plus, Save, Trash2 } from '../../components/icons';
import { IconButton, PrimaryButton } from '../../components/button';
import { FieldLabel } from '../../components/field';
import { TextArea, TextInput } from '../../components/input';
import { PasswordField } from './components/PasswordField';
import { SegmentedControl } from './components/SegmentedControl';
import { useServerForm } from './hooks/useServerForm';

export function App() {
	const form = useServerForm();
	const [activeTab, setActiveTab] = useState<'connection' | 'proxy' | 'commands'>('connection');
	if (!form.model) {
		return <main className="grid min-h-screen place-items-center text-sm text-(--vscode-descriptionForeground)">Loading...</main>;
	}

	const { model, values } = form;
	const usesAuthentication = model.serverType === 'ssh' || model.serverType === 'mysql';
	const supportsProxy = true;
	const tabs = [
		{ value: 'connection' as const, label: 'Connection' },
		...(supportsProxy ? [{ value: 'proxy' as const, label: 'Proxy' }] : []),
		...(model.serverType === 'ssh' ? [{ value: 'commands' as const, label: 'Commands' }] : []),
	];
	const selectedTab = tabs.some(tab => tab.value === activeTab) ? activeTab : 'connection';

	return (
		<form className="min-h-screen" onSubmit={event => { event.preventDefault(); form.save(); }}>
			<header className="sticky top-0 z-10 border-b border-(--vscode-panel-border,var(--vscode-widget-border)) bg-(--vscode-editor-background) py-3.5">
				<div className="mx-auto grid w-[min(880px,calc(100%-44px))] grid-cols-[minmax(160px,1.25fr)_minmax(140px,1fr)_auto] items-end gap-3 max-[680px]:w-[calc(100%-28px)] max-[520px]:grid-cols-[minmax(0,1fr)_auto]">
					<Field label="Name" required>
						<TextInput autoFocus required placeholder="Production" value={values.name} onChange={event => form.update('name', event.target.value)} />
					</Field>
					<Field label="Group" className="max-[520px]:col-start-1 max-[520px]:row-start-2">
						<TextInput list="server-groups" placeholder="No group" value={values.group} onChange={event => form.update('group', event.target.value)} />
						<datalist id="server-groups">{model.groups.map(group => <option key={group} value={group} />)}</datalist>
					</Field>
					<PrimaryButton className="max-[520px]:col-start-2 max-[520px]:row-span-2 max-[520px]:row-start-1 max-[520px]:self-start" type="submit" disabled={form.saving}>
						<Save size={15} />{form.saving ? 'Saving...' : 'Save'}
					</PrimaryButton>
				</div>
			</header>

			<main className={`mx-auto grid w-[min(880px,calc(100%-44px))] items-start py-8.5 pb-14 max-[680px]:w-[calc(100%-28px)] max-[680px]:pt-5 ${tabs.length > 1 ? 'grid-cols-[148px_minmax(0,1fr)] gap-7 max-[680px]:grid-cols-1 max-[680px]:gap-5' : 'grid-cols-[minmax(0,640px)] justify-center'}`}>
				{tabs.length > 1 && <nav className="sticky top-24 min-w-0 border-r border-(--vscode-panel-border,var(--vscode-widget-border)) pr-3 max-[680px]:static max-[680px]:overflow-x-auto max-[680px]:border-r-0 max-[680px]:border-b max-[680px]:pr-0" aria-label="Server settings">
					<div className="flex flex-col gap-0.5 max-[680px]:min-w-max max-[680px]:flex-row" role="tablist" aria-orientation="vertical">
						{tabs.map(tab => <button key={tab.value} type="button" role="tab" aria-selected={selectedTab === tab.value} className={`relative min-h-9 border-0 bg-transparent px-3 py-2 text-left text-sm max-[680px]:border-b-2 max-[680px]:text-center ${selectedTab === tab.value ? 'bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground) before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:bg-(--vscode-focusBorder) max-[680px]:bg-transparent max-[680px]:text-(--vscode-foreground) max-[680px]:before:inset-x-0 max-[680px]:before:top-auto max-[680px]:before:h-0.5 max-[680px]:before:w-auto' : 'text-(--vscode-descriptionForeground) hover:bg-(--vscode-list-hoverBackground) hover:text-(--vscode-foreground) max-[680px]:border-transparent'}`} onClick={() => setActiveTab(tab.value)}>{tab.label}</button>)}
					</div>
				</nav>}
				<div className="min-w-0">
					{selectedTab === 'connection' && <section aria-labelledby="connection-heading">
						<h2 className="mt-0 mb-3.5 text-sm font-semibold" id="connection-heading">Connection details</h2>
						<div className="grid gap-3.5">
							{model.serverType === 'container' ? <ContainerFields form={form} /> : <NetworkFields form={form} />}
							{usesAuthentication && <AuthenticationFields form={form} />}
						</div>
					</section>}
					{selectedTab === 'proxy' && supportsProxy && <ProxyFields form={form} />}
					{selectedTab === 'commands' && model.serverType === 'ssh' && <CommandFields form={form} />}
					{form.error && <div className="mt-4 border-l-[3px] border-(--vscode-errorForeground) bg-(--vscode-inputValidation-errorBackground) px-3 py-2.5 text-(--vscode-errorForeground)" role="alert">{form.error}</div>}
				</div>
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
		{model!.serverType === 'mysql' && <Field label="Database" required><TextInput required placeholder="app" value={values.database} onChange={event => form.update('database', event.target.value)} /></Field>}
	</>;
}

function ContainerFields({ form }: { form: FormState }) {
	const { values } = form;
	const runtimeDefaults = { docker: 'docker', podman: 'podman', apple: '/opt/homebrew/bin/container' } as const;
	return <>
		<SegmentedControl label="Container runtime" value={values.runtime} options={[{ value: 'docker', label: 'Docker' }, { value: 'podman', label: 'Podman' }, { value: 'apple', label: 'Apple' }]} onChange={value => { form.update('runtime', value); form.update('executablePath', runtimeDefaults[value]); }} />
		<Field label="Executable" required>
			<span className="flex">
				<TextInput className="min-w-0 border-r-0" required placeholder="docker" value={values.executablePath} onChange={event => form.update('executablePath', event.target.value)} />
				<IconButton type="button" title="Select executable" aria-label="Select executable" onClick={form.selectExecutable}><FolderOpen size={16} /></IconButton>
			</span>
		</Field>
	</>;
}

function ProxyFields({ form }: { form: FormState }) {
	const { model, values } = form;
	const existingServer = model!.server;
	const credentialRequired = !existingServer
		|| existingServer.type === 'container'
			? !existingServer || existingServer.connectionType === 'local' || Boolean(existingServer.sshServerId && values.sshServerId !== existingServer.sshServerId)
			: !('proxy' in existingServer && existingServer.proxy);
	const updateProxy = <Key extends 'proxyHost' | 'proxyPort' | 'proxyUsername' | 'proxyAuthType' | 'proxyPassword' | 'proxyPrivateKey' | 'proxyPassphrase'>(key: Key, value: FormState['values'][Key]) => {
		if (model!.serverType === 'container' && values.sshServerId) {
			form.update('sshServerId', '');
		}
		form.update(key, value);
	};
	return <section aria-labelledby="proxy-heading">
		<h2 className="mt-0 mb-3.5 text-sm font-semibold" id="proxy-heading">Proxy settings</h2>
		<div className="grid gap-3.5">
			<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={values.proxyEnabled} onChange={event => form.update('proxyEnabled', event.target.checked)} />Use SSH jump host</label>
			{values.proxyEnabled && <>
				<div className="grid grid-cols-[minmax(0,1fr)_112px] gap-3 max-[440px]:grid-cols-1">
					<Field label="Proxy host" required><TextInput required placeholder="bastion.example.com" value={values.proxyHost} onChange={event => updateProxy('proxyHost', event.target.value)} /></Field>
					<Field label="Port" required><TextInput required type="number" min={1} max={65535} value={values.proxyPort} onChange={event => updateProxy('proxyPort', event.target.value)} /></Field>
				</div>
				<Field label="Username" required><TextInput required autoComplete="username" placeholder="root" value={values.proxyUsername} onChange={event => updateProxy('proxyUsername', event.target.value)} /></Field>
				<SegmentedControl label="Proxy authentication method" value={values.proxyAuthType} options={[{ value: 'password', label: 'Password' }, { value: 'privateKey', label: 'Private key' }]} onChange={value => updateProxy('proxyAuthType', value)} />
				{values.proxyAuthType === 'password'
					? <PasswordField label="Proxy password" required={credentialRequired} value={values.proxyPassword} onChange={value => updateProxy('proxyPassword', value)} />
					: <>
						<Field label="Proxy private key" required={credentialRequired}>
							<span className="flex"><TextArea className="min-w-0 border-r-0" required={credentialRequired} spellCheck={false} placeholder="Paste the PEM or OpenSSH private key" value={values.proxyPrivateKey} onChange={event => updateProxy('proxyPrivateKey', event.target.value)} /><IconButton className="h-auto self-stretch" type="button" title="Select proxy private key" aria-label="Select proxy private key" onClick={form.selectProxyPrivateKey}><KeyRound size={16} /></IconButton></span>
						</Field>
						<PasswordField label="Proxy key passphrase" placeholder="Optional" value={values.proxyPassphrase} onChange={value => updateProxy('proxyPassphrase', value)} />
					</>}
			</>}
			{!values.proxyEnabled && <Field label="Proxy command"><TextInput spellCheck={false} placeholder="cloudflared access tcp --hostname example.com" value={values.proxyCommand} onChange={event => form.update('proxyCommand', event.target.value)} /></Field>}
		</div>
	</section>;
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
		<section aria-labelledby="commands-heading">
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