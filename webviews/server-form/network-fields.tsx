import { FileButton } from '../components/button';
import { Field, SegmentedControl } from '../components/form-controls';
import { SecretInput, TextArea, TextInput } from '../components/input';
import type { Dispatch, SetStateAction } from 'react';
import type { FormFieldsProps, ServerType } from './types';

interface NetworkFieldsProps extends FormFieldsProps {
	serverType: ServerType;
	credentialRequired: boolean;
	visibleSecrets: Record<string, boolean>;
	setVisibleSecrets: Dispatch<SetStateAction<Record<string, boolean>>>;
	onSelectPrivateKey(): void;
}

export function NetworkFields({ serverType, values, setValue, credentialRequired, visibleSecrets, setVisibleSecrets, onSelectPrivateKey }: NetworkFieldsProps) {
	const usesPrivateKey = values.authType === 'privateKey';
	return <>
		<div className="grid grid-cols-4 gap-4 max-sm:grid-cols-1">
			<Field className="col-span-3 max-sm:col-span-1" label="Host" required><TextInput autoComplete="off" required placeholder="server.example.com" value={values.host} onChange={event => setValue('host', event.target.value)} /></Field>
			<Field label="Port" required><TextInput type="number" min="1" max="65535" required value={values.port} onChange={event => setValue('port', event.target.value)} /></Field>
		</div>
		<Field label="Username" required><TextInput autoComplete="username" required placeholder="root" value={values.username} onChange={event => setValue('username', event.target.value)} /></Field>
		{serverType === 'ssh' && <Field label="Proxy command"><TextInput autoComplete="off" spellCheck={false} placeholder="cloudflared access tcp --hostname example.com" value={values.proxyCommand} onChange={event => setValue('proxyCommand', event.target.value)} /></Field>}
		{serverType === 'mysql'
			? <Field label="Database" required><TextInput autoComplete="off" required placeholder="app" value={values.database} onChange={event => setValue('database', event.target.value)} /></Field>
			: <SegmentedControl label="Authentication method" value={values.authType} options={[["password", "Password"], ["privateKey", "Private key"]]} onChange={value => setValue('authType', value)} />}
		{!usesPrivateKey && <Field label="Password" required={credentialRequired}><SecretInput value={values.password} visible={visibleSecrets.password} autoComplete="current-password" onChange={value => setValue('password', value)} toggle={() => setVisibleSecrets(current => ({ ...current, password: !current.password }))} /></Field>}
		{serverType === 'ssh' && usesPrivateKey && <div className="grid gap-4">
			<Field label="Private key" required={credentialRequired} action={<FileButton label="Select file" onClick={onSelectPrivateKey} />}>
				<TextArea required={credentialRequired} spellCheck={false} placeholder="Paste the PEM or OpenSSH private key" value={values.privateKey} onChange={event => setValue('privateKey', event.target.value)} />
			</Field>
			<Field label="Key passphrase"><SecretInput value={values.passphrase} visible={visibleSecrets.passphrase} autoComplete="off" onChange={value => setValue('passphrase', value)} toggle={() => setVisibleSecrets(current => ({ ...current, passphrase: !current.passphrase }))} /></Field>
		</div>}
	</>;
}