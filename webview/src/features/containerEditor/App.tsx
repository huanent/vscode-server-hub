import { Boxes, CircleAlert, CircleCheck, CircleSlash, Database, Info, LoaderCircle, Network, Package, Pencil, Play, RefreshCw, RotateCw, Square, X } from '../../components/icons';
import { useEffect } from 'react';
import { FieldLabel, IconButton, PrimaryButton, SelectInput, TextArea, TextInput } from '../../components/ui';
import { useContainerEditor } from './hooks/useContainerEditor';
import type { ResourceType } from './types';

const resources: { type: ResourceType; label: string; icon: typeof Boxes }[] = [
	{ type: 'containers', label: 'Containers', icon: Boxes },
	{ type: 'images', label: 'Images', icon: Package },
	{ type: 'volumes', label: 'Volumes', icon: Database },
	{ type: 'networks', label: 'Networks', icon: Network },
];

export function App() {
	const editor = useContainerEditor();
	useEffect(() => {
		const close = (event: KeyboardEvent) => { if (event.key === 'Escape') editor.containerEditor ? editor.closeContainerEditor() : editor.closeDetails(); };
		window.addEventListener('keydown', close);
		return () => window.removeEventListener('keydown', close);
	}, [editor.details, editor.containerEditor]);

	if (!editor.server) {
		return <main className="grid min-h-screen place-items-center text-muted"><LoaderCircle className="animate-spin" size={20} /></main>;
	}
	const statusLabel = editor.serviceMessage || ({ checking: 'Checking service', running: 'Running', stopped: 'Stopped', error: 'Unavailable' } as const)[editor.serviceState];
	const StatusIcon = editor.serviceState === 'checking' ? LoaderCircle : editor.serviceState === 'running' ? CircleCheck : editor.serviceState === 'stopped' ? CircleSlash : CircleAlert;
	return (
		<div className="grid h-screen min-w-75 grid-rows-[42px_minmax(0,1fr)] overflow-hidden p-1 select-none">
		<header className="flex min-w-0 items-center gap-2.5 border-b border-border px-2">
			<span className="min-w-0 overflow-hidden text-[13px] font-semibold text-ellipsis whitespace-nowrap" title={editor.server.executablePath}>{editor.server.name}</span>
			<span className="text-xs capitalize text-muted max-[640px]:hidden">{editor.server.runtime}</span>
			<span className={`ml-auto inline-flex min-w-0 items-center gap-1.5 text-xs ${editor.serviceState === 'running' ? 'text-success' : editor.serviceState === 'checking' ? 'text-muted' : 'text-error'}`} title={statusLabel}>
				<StatusIcon className={editor.serviceState === 'checking' || editor.systemPending ? 'animate-spin' : ''} size={14} /><span>{statusLabel}</span>
			</span>
			{editor.server.runtime === 'apple' && <IconButton className="border-0" type="button" disabled={editor.systemPending || editor.serviceState === 'checking'} title={editor.serviceState === 'running' ? 'Stop Apple Container system' : 'Start Apple Container system'} onClick={editor.systemAction}>{editor.systemPending ? <LoaderCircle className="animate-spin" size={16} /> : editor.serviceState === 'running' ? <Square size={15} /> : <Play size={16} />}</IconButton>}
			<IconButton className="border-0" type="button" title="Refresh" aria-label="Refresh" onClick={editor.refresh}><RefreshCw size={16} /></IconButton>
		</header>
		<div className="grid min-h-0 min-w-0 grid-cols-[190px_minmax(0,1fr)] max-[640px]:grid-cols-1 max-[640px]:grid-rows-[41px_minmax(0,1fr)]">
			<aside className="min-h-0 min-w-0 overflow-auto border-r border-border p-1.5 max-[640px]:overflow-visible max-[640px]:border-r-0 max-[640px]:border-b max-[640px]:px-2">
				<nav className="grid gap-0.5 max-[640px]:grid-cols-4" aria-label="Container resources">
					{resources.map(item => <button key={item.type} type="button" className={`flex min-h-8 w-full items-center gap-2 border-0 bg-transparent px-2.5 text-left text-foreground hover:bg-hover max-[640px]:justify-center ${editor.resource === item.type ? 'bg-selection! text-selection-foreground!' : ''}`} aria-selected={editor.resource === item.type} onClick={() => editor.setResource(item.type)}><item.icon size={16} /><span className="max-[640px]:hidden">{item.label}</span></button>)}
				</nav>
			</aside>
			<main className="min-h-0 min-w-0 overflow-hidden">
				{editor.loading ? <Message><LoaderCircle className="animate-spin" size={18} />Loading...</Message> : editor.error ? <Message error>{editor.error}</Message> : editor.rows.length === 0 ? <Message>No resources found.</Message> : <ResourceTable editor={editor} />}
			</main>
		</div>
		{editor.details && <div className="fixed inset-0 z-20 grid place-items-center bg-black/45 p-6" onMouseDown={event => { if (event.target === event.currentTarget) editor.closeDetails(); }}>
			<section className="grid h-[min(760px,100%)] w-[min(840px,100%)] min-h-0 grid-rows-[42px_minmax(0,1fr)] overflow-hidden border border-border bg-app shadow-widget" role="dialog" aria-modal="true" aria-labelledby="container-details-title">
				<header className="flex min-w-0 items-center border-b border-border pr-1.5 pl-3.5"><h2 id="container-details-title" className="m-0 min-w-0 overflow-hidden text-[13px] font-semibold text-ellipsis whitespace-nowrap">{editor.details.title}</h2><IconButton className="ml-auto border-0" autoFocus type="button" title="Close" aria-label="Close" onClick={editor.closeDetails}><X size={16} /></IconButton></header>
				<pre className="m-0 overflow-auto bg-code p-3 font-mono text-xs leading-6 whitespace-pre-wrap wrap-break-word">{editor.details.content}</pre>
			</section>
		</div>}
		{editor.containerEditor && <ContainerEditDialog editor={editor} />}
		</div>
	);
}

type EditorState = ReturnType<typeof useContainerEditor>;

function ResourceTable({ editor }: { editor: EditorState }) {
	return <div className="h-full w-full overflow-auto"><table className="w-full table-fixed border-collapse"><thead><tr>{[['Name', 'w-[28%]'], ['Status', 'w-[17%]'], ['Details', ''], ['Size', 'w-25 max-[640px]:hidden'], ['', 'w-26']].map(([label, className], index) => <th key={index} className={`sticky top-0 z-10 h-7.5 border-b border-border bg-app px-2.5 text-left text-xs font-normal text-muted ${className}`}>{label}</th>)}</tr></thead><tbody>{editor.rows.map(row => {
		const running = /^(running|up)\b/i.test(row.status.trim());
		return <tr key={row.id} className="hover:bg-hover">{[row.name, row.status, row.detail].map((value, index) => <td key={index} className="h-8 overflow-hidden px-2.5 text-ellipsis whitespace-nowrap" title={value}>{value}</td>)}<td className="h-8 overflow-hidden px-2.5 text-ellipsis whitespace-nowrap max-[640px]:hidden" title={row.size}>{row.size}</td><td className="h-8 px-2"><span className="flex justify-end gap-0.5">{editor.resource === 'containers' && <><IconButton className="border-0" disabled={Boolean(editor.containerPendingId)} type="button" title={`Edit and recreate ${row.name}`} onClick={() => editor.editContainer(row.id)}><Pencil size={15} /></IconButton><IconButton className="border-0" disabled={Boolean(editor.containerPendingId)} type="button" title={`${running ? 'Stop' : 'Start'} ${row.name}`} onClick={() => editor.containerAction(row.id, running ? 'stop' : 'start')}>{editor.containerPendingId === row.id ? <LoaderCircle className="animate-spin" size={15} /> : running ? <Square size={14} /> : <Play size={15} />}</IconButton></>}<IconButton className="border-0" type="button" title="Show details" onClick={() => editor.inspect(row)}><Info size={16} /></IconButton></span></td></tr>;
	})}</tbody></table></div>;
}

function ContainerEditDialog({ editor }: { editor: EditorState }) {
	const state = editor.containerEditor!;
	const config = state.config;
	return <div className="fixed inset-0 z-30 grid place-items-center bg-black/45 p-4" onMouseDown={event => { if (event.target === event.currentTarget) editor.closeContainerEditor(); }}>
		<form className="grid h-[min(780px,100%)] w-[min(760px,100%)] min-h-0 grid-rows-[46px_minmax(0,1fr)_54px] overflow-hidden border border-border bg-app shadow-widget" role="dialog" aria-modal="true" aria-labelledby="container-edit-title" onSubmit={event => { event.preventDefault(); editor.recreateContainer(); }}>
			<header className="flex items-center border-b border-border px-3.5"><h2 id="container-edit-title" className="m-0 text-[13px] font-semibold">Edit and recreate container</h2><IconButton className="ml-auto border-0" type="button" disabled={state.saving} title="Close" onClick={editor.closeContainerEditor}><X size={16} /></IconButton></header>
			<div className="min-h-0 overflow-auto p-4">
				{state.loading ? <Message><LoaderCircle className="animate-spin" size={18} />Loading configuration...</Message> : config ? <div className="grid gap-3.5">
					<div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1"><EditField label="Name" required><TextInput autoFocus required disabled={state.saving} value={config.name} onChange={event => editor.updateContainerConfig('name', event.target.value)} /></EditField><EditField label="Image" required><TextInput required disabled={state.saving} value={config.image} onChange={event => editor.updateContainerConfig('image', event.target.value)} /></EditField></div>
					<div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1"><EditField label="Entrypoint"><TextInput disabled={state.saving} value={config.entrypoint} onChange={event => editor.updateContainerConfig('entrypoint', event.target.value)} /></EditField><EditField label="User"><TextInput disabled={state.saving} value={config.user} onChange={event => editor.updateContainerConfig('user', event.target.value)} /></EditField></div>
					<div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1"><EditField label="Working directory"><TextInput disabled={state.saving} value={config.workingDirectory} onChange={event => editor.updateContainerConfig('workingDirectory', event.target.value)} /></EditField><EditField label="Restart policy"><SelectInput disabled={state.saving || editor.server?.runtime === 'apple'} value={config.restartPolicy} onChange={event => editor.updateContainerConfig('restartPolicy', event.target.value)}><option value="">None</option><option value="no">No</option><option value="always">Always</option><option value="unless-stopped">Unless stopped</option><option value="on-failure">On failure</option></SelectInput></EditField></div>
					<EditField label="Command" hint="one argument per line"><TextArea className="min-h-24" disabled={state.saving} value={config.command} onChange={event => editor.updateContainerConfig('command', event.target.value)} /></EditField>
					<div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1"><EditField label="Environment" hint="KEY=value, one per line"><TextArea disabled={state.saving} value={config.environment} onChange={event => editor.updateContainerConfig('environment', event.target.value)} /></EditField><EditField label="Published ports" hint="host:container, one per line"><TextArea disabled={state.saving} value={config.ports} onChange={event => editor.updateContainerConfig('ports', event.target.value)} /></EditField></div>
					{editor.server?.runtime === 'apple' && <EditField label="Published sockets" hint="host_path:container_path, one per line"><TextArea className="min-h-20" disabled={state.saving} value={config.sockets} onChange={event => editor.updateContainerConfig('sockets', event.target.value)} /></EditField>}
					<EditSection title="Storage and network">
						<EditField label="Networks" hint="name[,mac=...][,mtu=...], one per line"><TextArea className="min-h-24" disabled={state.saving} value={config.networks} onChange={event => editor.updateContainerConfig('networks', event.target.value)} /></EditField>
						<div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1"><EditField label="Volumes" hint="source:target, one per line"><TextArea disabled={state.saving} value={config.volumes} onChange={event => editor.updateContainerConfig('volumes', event.target.value)} /></EditField><EditField label="Mounts" hint="type=...,source=...,target=..."><TextArea disabled={state.saving} value={config.mounts} onChange={event => editor.updateContainerConfig('mounts', event.target.value)} /></EditField></div>
						<EditField label="Tmpfs" hint="target[:options], one per line"><TextArea className="min-h-20" disabled={state.saving} value={config.tmpfs} onChange={event => editor.updateContainerConfig('tmpfs', event.target.value)} /></EditField>
					</EditSection>
					<EditSection title="Runtime">
						<div className="grid grid-cols-3 gap-3 max-[640px]:grid-cols-1"><EditField label="CPUs"><TextInput disabled={state.saving} value={config.cpus} onChange={event => editor.updateContainerConfig('cpus', event.target.value)} /></EditField><EditField label="Memory" hint="bytes or 1G"><TextInput disabled={state.saving} value={config.memory} onChange={event => editor.updateContainerConfig('memory', event.target.value)} /></EditField><EditField label="Shared memory"><TextInput disabled={state.saving} value={config.shmSize} onChange={event => editor.updateContainerConfig('shmSize', event.target.value)} /></EditField></div>
						<div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1"><EditField label="Platform"><TextInput disabled={state.saving} value={config.platform} onChange={event => editor.updateContainerConfig('platform', event.target.value)} /></EditField><EditField label="Runtime handler"><TextInput disabled={state.saving} value={config.runtime} onChange={event => editor.updateContainerConfig('runtime', event.target.value)} /></EditField></div>
						<div className="flex flex-wrap gap-x-5 gap-y-2">{([['interactive', 'Interactive'], ['tty', 'TTY'], ['readOnly', 'Read only'], ['init', 'Init'], ['rosetta', 'Rosetta'], ['ssh', 'SSH forwarding'], ['virtualization', 'Virtualization']] as const).map(([key, label]) => <label key={key} className={`inline-flex items-center gap-2 text-xs ${editor.server?.runtime !== 'apple' && (key === 'rosetta' || key === 'ssh' || key === 'virtualization') ? 'hidden' : ''}`}><input type="checkbox" disabled={state.saving} checked={config[key]} onChange={event => editor.updateContainerConfig(key, event.target.checked)} />{label}</label>)}</div>
					</EditSection>
					<EditSection title="Security and metadata">
						<div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1"><EditField label="Capabilities added" hint="one per line"><TextArea className="min-h-20" disabled={state.saving} value={config.capAdd} onChange={event => editor.updateContainerConfig('capAdd', event.target.value)} /></EditField><EditField label="Capabilities dropped" hint="one per line"><TextArea className="min-h-20" disabled={state.saving} value={config.capDrop} onChange={event => editor.updateContainerConfig('capDrop', event.target.value)} /></EditField></div>
						<div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1"><EditField label="Labels" hint="KEY=value, one per line"><TextArea disabled={state.saving} value={config.labels} onChange={event => editor.updateContainerConfig('labels', event.target.value)} /></EditField><EditField label="Ulimits" hint="type=soft[:hard], one per line"><TextArea disabled={state.saving} value={config.ulimits} onChange={event => editor.updateContainerConfig('ulimits', event.target.value)} /></EditField></div>
					</EditSection>
					<EditSection title="DNS">
						<div className="grid grid-cols-3 gap-3 max-[640px]:grid-cols-1"><EditField label="Servers" hint="one per line"><TextArea className="min-h-20" disabled={state.saving} value={config.dnsServers} onChange={event => editor.updateContainerConfig('dnsServers', event.target.value)} /></EditField><EditField label="Search domains" hint="one per line"><TextArea className="min-h-20" disabled={state.saving} value={config.dnsSearch} onChange={event => editor.updateContainerConfig('dnsSearch', event.target.value)} /></EditField><EditField label="Options" hint="one per line"><TextArea className="min-h-20" disabled={state.saving} value={config.dnsOptions} onChange={event => editor.updateContainerConfig('dnsOptions', event.target.value)} /></EditField></div>
					</EditSection>
				</div> : null}
				{state.error && <div className="mt-4 border-l-[3px] border-error bg-error-background px-3 py-2.5 text-error" role="alert">{state.error}</div>}
			</div>
			<footer className="flex items-center justify-end gap-2 border-t border-border px-3.5"><button className="h-8.5 border border-button-secondary bg-button-secondary px-3 text-button-secondary-foreground hover:bg-button-secondary-hover disabled:opacity-55" type="button" disabled={state.saving} onClick={editor.closeContainerEditor}>Cancel</button><PrimaryButton type="submit" disabled={!config || state.loading || state.saving}><RotateCw className={state.saving ? 'animate-spin' : ''} size={15} />{state.saving ? 'Recreating...' : 'Recreate'}</PrimaryButton></footer>
		</form>
	</div>;
}

function EditField({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
	return <label className="block min-w-0"><FieldLabel hint={hint}>{label}{required && <span className="ml-1 text-error">*</span>}</FieldLabel>{children}</label>;
}

function EditSection({ title, children }: { title: string; children: React.ReactNode }) {
	return <section className="grid gap-3.5 border-t border-border pt-3.5"><h3 className="m-0 text-xs font-semibold text-muted">{title}</h3>{children}</section>;
}

function Message({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
	return <div className={`flex items-center justify-center gap-2 px-3 py-7 text-center ${error ? 'text-error' : 'text-muted'}`}>{children}</div>;
}