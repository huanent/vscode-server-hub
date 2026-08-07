import { CircleAlert, LoaderCircle } from 'lucide-react';
import { useRef } from 'react';
import { SftpPanel } from './SftpPanel';
import { TerminalView, type TerminalViewHandle } from './TerminalView';
import { useSshTerminal } from './useSshTerminal';

export function SshTerminalApp() {
	const terminalRef = useRef<TerminalViewHandle>(null);
	const ssh = useSshTerminal(data => terminalRef.current?.writeBase64(data), () => terminalRef.current?.fit());
	return <div className="grid h-screen grid-rows-[34px_minmax(0,1fr)] overflow-hidden px-1">
		<header className="grid grid-cols-4 border-b border-(--vscode-panel-border)" aria-label="Remote server metrics">{Object.entries(ssh.metrics).map(([label, value], index) => <div key={label} className="relative flex min-w-0 items-center justify-between gap-2 px-2.5 pl-3.5 before:absolute before:left-1.5 before:h-3 before:w-0.75 before:bg-(--metric-color)" style={{ '--metric-color': [`var(--vscode-charts-blue)`, `var(--vscode-charts-green)`, `var(--vscode-charts-yellow)`, `var(--vscode-charts-purple)`][index] } as React.CSSProperties}><span className="text-[10px] font-semibold uppercase text-(--vscode-descriptionForeground)">{label}</span><span className="min-w-0 overflow-hidden font-(--vscode-editor-font-family) text-xs text-ellipsis whitespace-nowrap">{value}</span></div>)}</header>
		<main className={`grid min-h-0 ${ssh.sftpVisible ? 'grid-cols-[minmax(320px,3fr)_minmax(280px,2fr)] max-[760px]:grid-cols-[minmax(260px,1fr)_minmax(240px,1fr)]' : 'grid-cols-1'}`}>
			<section className="relative min-h-0 min-w-0 py-1.5"><TerminalView ref={terminalRef} onData={ssh.input} onResize={ssh.resize} onReady={ssh.ready} />{ssh.status !== 'connected' && <div className={`pointer-events-none absolute inset-0 z-10 flex items-center justify-center ${ssh.status === 'error' ? 'text-(--vscode-errorForeground)' : 'text-(--vscode-descriptionForeground)'}`}><div className="grid max-w-[min(520px,calc(100%-32px))] grid-cols-[18px_auto] items-center gap-x-3 gap-y-1"><span className="row-span-2">{ssh.status === 'connecting' ? <LoaderCircle className="animate-spin text-(--vscode-progressBar-background)" size={17} /> : <CircleAlert size={17} />}</span><strong className="text-[13px]">{ssh.status === 'connecting' ? 'Connecting' : ssh.status === 'error' ? 'Connection failed' : 'Connection closed'}</strong><span className="overflow-hidden font-(--vscode-editor-font-family) text-[11px] text-ellipsis whitespace-nowrap">{ssh.statusMessage || ssh.server?.address}</span></div></div>}</section>
			{ssh.sftpVisible && <SftpPanel sftp={{ sftpPath: ssh.sftpPath, parentPath: ssh.parentPath, entries: ssh.entries, favorites: ssh.favorites, loading: ssh.sftpLoading, list: ssh.list, toggleFavorite: ssh.toggleFavorite, createDirectory: ssh.createDirectory, upload: ssh.upload, properties: ssh.properties, download: ssh.download, deleteEntry: ssh.deleteEntry, copyPath: ssh.copyPath, edit: ssh.edit }} />}
		</main>
	</div>;
}