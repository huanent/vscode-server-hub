import { Boxes, CircleAlert, CircleCheck, CircleSlash, Database, Info, LoaderCircle, Network, Package, Play, RefreshCw, Square, X } from 'lucide-react';
import { useEffect } from 'react';
import { IconButton } from '../../components/ui';
import { useContainerEditor } from './hooks/useContainerEditor';
import type { ResourceType } from './types';

const resources: { type: ResourceType; label: string; icon: typeof Boxes }[] = [
	{ type: 'containers', label: 'Containers', icon: Boxes },
	{ type: 'images', label: 'Images', icon: Package },
	{ type: 'volumes', label: 'Volumes', icon: Database },
	{ type: 'networks', label: 'Networks', icon: Network },
];

export function ContainerEditorApp() {
	const editor = useContainerEditor();
	useEffect(() => {
		const close = (event: KeyboardEvent) => { if (event.key === 'Escape') editor.closeDetails(); };
		window.addEventListener('keydown', close);
		return () => window.removeEventListener('keydown', close);
	}, [editor.details]);

	if (!editor.server) {
		return <main className="grid min-h-screen place-items-center text-(--vscode-descriptionForeground)"><LoaderCircle className="animate-spin" size={20} /></main>;
	}
	const statusLabel = editor.serviceMessage || ({ checking: 'Checking service', running: 'Running', stopped: 'Stopped', error: 'Unavailable' } as const)[editor.serviceState];
	const StatusIcon = editor.serviceState === 'checking' ? LoaderCircle : editor.serviceState === 'running' ? CircleCheck : editor.serviceState === 'stopped' ? CircleSlash : CircleAlert;
	return (
		<div className="grid h-screen min-w-75 grid-rows-[42px_minmax(0,1fr)] overflow-hidden p-1 select-none">
		<header className="flex min-w-0 items-center gap-2.5 border-b border-(--vscode-panel-border) px-2">
			<span className="min-w-0 overflow-hidden text-[13px] font-semibold text-ellipsis whitespace-nowrap" title={editor.server.executablePath}>{editor.server.name}</span>
			<span className="text-xs capitalize text-(--vscode-descriptionForeground) max-[640px]:hidden">{editor.server.runtime}</span>
			<span className={`ml-auto inline-flex min-w-0 items-center gap-1.5 text-xs ${editor.serviceState === 'running' ? 'text-(--vscode-testing-iconPassed,var(--vscode-charts-green))' : editor.serviceState === 'checking' ? 'text-(--vscode-descriptionForeground)' : 'text-(--vscode-errorForeground)'}`} title={statusLabel}>
				<StatusIcon className={editor.serviceState === 'checking' || editor.systemPending ? 'animate-spin' : ''} size={14} /><span>{statusLabel}</span>
			</span>
			{editor.server.runtime === 'apple' && <IconButton className="border-0" type="button" disabled={editor.systemPending || editor.serviceState === 'checking'} title={editor.serviceState === 'running' ? 'Stop Apple Container system' : 'Start Apple Container system'} onClick={editor.systemAction}>{editor.systemPending ? <LoaderCircle className="animate-spin" size={16} /> : editor.serviceState === 'running' ? <Square size={15} /> : <Play size={16} />}</IconButton>}
			<IconButton className="border-0" type="button" title="Refresh" aria-label="Refresh" onClick={editor.refresh}><RefreshCw size={16} /></IconButton>
		</header>
		<div className="grid min-h-0 min-w-0 grid-cols-[190px_minmax(0,1fr)] max-[640px]:grid-cols-1 max-[640px]:grid-rows-[41px_minmax(0,1fr)]">
			<aside className="min-h-0 min-w-0 overflow-auto border-r border-(--vscode-panel-border) p-1.5 max-[640px]:overflow-visible max-[640px]:border-r-0 max-[640px]:border-b max-[640px]:px-2">
				<nav className="grid gap-0.5 max-[640px]:grid-cols-4" aria-label="Container resources">
					{resources.map(item => <button key={item.type} type="button" className={`flex min-h-8 w-full items-center gap-2 border-0 bg-transparent px-2.5 text-left text-(--vscode-foreground) hover:bg-(--vscode-list-hoverBackground) max-[640px]:justify-center ${editor.resource === item.type ? 'bg-(--vscode-list-activeSelectionBackground)! text-(--vscode-list-activeSelectionForeground)!' : ''}`} aria-selected={editor.resource === item.type} onClick={() => editor.setResource(item.type)}><item.icon size={16} /><span className="max-[640px]:hidden">{item.label}</span></button>)}
				</nav>
			</aside>
			<main className="min-h-0 min-w-0 overflow-hidden">
				{editor.loading ? <Message><LoaderCircle className="animate-spin" size={18} />Loading...</Message> : editor.error ? <Message error>{editor.error}</Message> : editor.rows.length === 0 ? <Message>No resources found.</Message> : <ResourceTable editor={editor} />}
			</main>
		</div>
		{editor.details && <div className="fixed inset-0 z-20 grid place-items-center bg-black/45 p-6" onMouseDown={event => { if (event.target === event.currentTarget) editor.closeDetails(); }}>
			<section className="grid h-[min(760px,100%)] w-[min(840px,100%)] min-h-0 grid-rows-[42px_minmax(0,1fr)] overflow-hidden border border-(--vscode-panel-border) bg-(--vscode-editor-background) shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="container-details-title">
				<header className="flex min-w-0 items-center border-b border-(--vscode-panel-border) pr-1.5 pl-3.5"><h2 id="container-details-title" className="m-0 min-w-0 overflow-hidden text-[13px] font-semibold text-ellipsis whitespace-nowrap">{editor.details.title}</h2><IconButton className="ml-auto border-0" autoFocus type="button" title="Close" aria-label="Close" onClick={editor.closeDetails}><X size={16} /></IconButton></header>
				<pre className="m-0 overflow-auto bg-(--vscode-textCodeBlock-background) p-3 font-(--vscode-editor-font-family) text-xs leading-6 whitespace-pre-wrap wrap-break-word">{editor.details.content}</pre>
			</section>
		</div>}
		</div>
	);
}

type EditorState = ReturnType<typeof useContainerEditor>;

function ResourceTable({ editor }: { editor: EditorState }) {
	return <div className="h-full w-full overflow-auto"><table className="w-full table-fixed border-collapse"><thead><tr>{[['Name', 'w-[28%]'], ['Status', 'w-[17%]'], ['Details', ''], ['Size', 'w-25 max-[640px]:hidden'], ['', 'w-26']].map(([label, className], index) => <th key={index} className={`sticky top-0 z-10 h-7.5 border-b border-(--vscode-panel-border) bg-(--vscode-editor-background) px-2.5 text-left text-xs font-normal text-(--vscode-descriptionForeground) ${className}`}>{label}</th>)}</tr></thead><tbody>{editor.rows.map(row => {
		const running = /^(running|up)\b/i.test(row.status.trim());
		return <tr key={row.id} className="hover:bg-(--vscode-list-hoverBackground)">{[row.name, row.status, row.detail].map((value, index) => <td key={index} className="h-8 overflow-hidden px-2.5 text-ellipsis whitespace-nowrap" title={value}>{value}</td>)}<td className="h-8 overflow-hidden px-2.5 text-ellipsis whitespace-nowrap max-[640px]:hidden" title={row.size}>{row.size}</td><td className="h-8 px-2"><span className="flex justify-end gap-0.5">{editor.resource === 'containers' && <IconButton className="border-0" disabled={Boolean(editor.containerPendingId)} type="button" title={`${running ? 'Stop' : 'Start'} ${row.name}`} onClick={() => editor.containerAction(row.id, running ? 'stop' : 'start')}>{editor.containerPendingId === row.id ? <LoaderCircle className="animate-spin" size={15} /> : running ? <Square size={14} /> : <Play size={15} />}</IconButton>}<IconButton className="border-0" type="button" title="Show details" onClick={() => editor.inspect(row)}><Info size={16} /></IconButton></span></td></tr>;
	})}</tbody></table></div>;
}

function Message({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
	return <div className={`flex items-center justify-center gap-2 px-3 py-7 text-center ${error ? 'text-(--vscode-errorForeground)' : 'text-(--vscode-descriptionForeground)'}`}>{children}</div>;
}