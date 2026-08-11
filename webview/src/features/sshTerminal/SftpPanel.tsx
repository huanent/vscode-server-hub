import { ArrowUp, Copy, Download, Edit3, File, Folder, FolderPlus, Info, MoreHorizontal, RefreshCw, Star, Trash2, Upload } from '../../components/icons';
import { useEffect, useState } from 'react';
import { IconButton, TextInput } from '../../components/ui';
import type { SftpEntry } from './types';

interface SftpActions {
	sftpPath: string;
	parentPath: string | null;
	entries: SftpEntry[];
	favorites: string[];
	loading: boolean;
	list: (path: string) => void;
	toggleFavorite: () => void;
	createDirectory: (path?: string) => void;
	upload: (path?: string) => void;
	properties: (path?: string) => void;
	download: (entry: SftpEntry) => void;
	deleteEntry: (entry: SftpEntry) => void;
	copyPath: (path: string) => void;
	edit: (path: string) => void;
}

export function SftpPanel({ sftp }: { sftp: SftpActions }) {
	const [pathValue, setPathValue] = useState(sftp.sftpPath);
	const [showFavorites, setShowFavorites] = useState(false);
	const [showMore, setShowMore] = useState(false);
	const [menu, setMenu] = useState<{ entry: SftpEntry; x: number; y: number }>();
	useEffect(() => setPathValue(sftp.sftpPath), [sftp.sftpPath]);
	const favorite = sftp.favorites.includes(sftp.sftpPath);
	return <aside className="grid min-h-0 min-w-0 grid-rows-[38px_30px_minmax(0,1fr)] border-l border-(--vscode-panel-border) bg-(--vscode-editor-background) select-none" onClick={() => { setMenu(undefined); setShowMore(false); }}>
		<header className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-1.5 border-b border-(--vscode-panel-border) py-1 pr-1 pl-2">
			<IconButton className="size-7 border-0" disabled={!sftp.parentPath} title="Parent directory" onClick={() => sftp.parentPath && sftp.list(sftp.parentPath)}><ArrowUp size={15} /></IconButton>
			<div className="relative min-w-0"><TextInput aria-label="Remote path" className="h-6.5 pr-7 font-(--vscode-editor-font-family) text-xs" disabled={sftp.loading} value={pathValue} onFocus={() => setShowFavorites(true)} onChange={event => setPathValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && pathValue.trim()) { sftp.list(pathValue.trim()); setShowFavorites(false); } if (event.key === 'Escape') { setPathValue(sftp.sftpPath); setShowFavorites(false); } }} /><IconButton className={`absolute top-px right-px size-6 border-0 ${favorite ? 'text-(--vscode-charts-yellow)' : ''}`} title={favorite ? 'Remove from favorites' : 'Add to favorites'} onClick={event => { event.stopPropagation(); sftp.toggleFavorite(); }}><Star size={14} fill={favorite ? 'currentColor' : 'none'} /></IconButton>{showFavorites && sftp.favorites.length > 0 && <div className="absolute top-7 right-0 left-0 z-20 max-h-52 overflow-auto border border-(--vscode-dropdown-border,var(--vscode-panel-border)) bg-(--vscode-dropdown-background) p-1 shadow-lg">{sftp.favorites.map(path => <button key={path} className="block min-h-7 w-full overflow-hidden border-0 bg-transparent px-2 text-left font-(--vscode-editor-font-family) text-xs text-ellipsis whitespace-nowrap hover:bg-(--vscode-list-activeSelectionBackground) hover:text-(--vscode-list-activeSelectionForeground)" title={path} onMouseDown={event => event.preventDefault()} onClick={() => { sftp.list(path); setShowFavorites(false); }}>{path}</button>)}</div>}</div>
			<IconButton className="size-7 border-0" title="Refresh" onClick={() => sftp.list(sftp.sftpPath)}><RefreshCw size={15} /></IconButton>
			<div className="relative"><IconButton className="size-7 border-0" title="More actions" onClick={event => { event.stopPropagation(); setShowMore(current => !current); }}><MoreHorizontal size={16} /></IconButton>{showMore && <Menu className="absolute top-7 right-0" items={[{ icon: <FolderPlus size={14} />, label: 'New Folder', action: () => sftp.createDirectory() }, { icon: <Upload size={14} />, label: 'Upload Files', action: () => sftp.upload() }, { icon: <Info size={14} />, label: 'Properties', action: () => sftp.properties() }]} />}</div>
		</header>
		<div className="grid grid-cols-[minmax(140px,1fr)_86px_130px] items-center border-b border-(--vscode-panel-border) px-3 text-[11px] text-(--vscode-descriptionForeground) max-[760px]:grid-cols-[minmax(130px,1fr)_80px] max-[760px]:[&>span:last-child]:hidden"><span>Name</span><span className="text-right">Size</span><span className="text-right">Modified</span></div>
		<div className="relative min-h-0 overflow-hidden"><div className="h-full overflow-auto py-1 pl-1">{sftp.entries.map(entry => <div key={entry.path} className={`grid min-h-7.5 grid-cols-[minmax(140px,1fr)_86px_130px] items-center px-1.5 hover:bg-(--vscode-list-hoverBackground) max-[760px]:grid-cols-[minmax(130px,1fr)_80px] ${menu?.entry.path === entry.path ? 'bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground)' : ''}`} onDoubleClick={() => entry.isDirectory && sftp.list(entry.path)} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); setMenu({ entry, x: event.clientX, y: event.clientY }); }}><span className="flex min-w-0 items-center gap-2">{entry.isDirectory ? <Folder className="shrink-0 text-(--vscode-symbolIcon-folderForeground,var(--vscode-icon-foreground))" size={15} /> : <File className="shrink-0" size={15} />}<span className="overflow-hidden text-ellipsis whitespace-nowrap">{entry.name}</span></span><span className="overflow-hidden text-right text-[11px] text-ellipsis whitespace-nowrap text-(--vscode-descriptionForeground)">{entry.isDirectory ? '' : formatFileSize(entry.size)}</span><span className="overflow-hidden text-right text-[11px] text-ellipsis whitespace-nowrap text-(--vscode-descriptionForeground) max-[760px]:hidden">{new Date(entry.modifiedAt).toLocaleString()}</span></div>)}</div>{sftp.loading ? <Status>Loading {sftp.sftpPath}...</Status> : sftp.entries.length === 0 && <Status>This directory is empty.</Status>}</div>
		{menu && <Menu className="fixed" style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 210) }} items={[...(menu.entry.isDirectory ? [{ icon: <FolderPlus size={14} />, label: 'New Folder', action: () => sftp.createDirectory(menu.entry.path) }, { icon: <Upload size={14} />, label: 'Upload Files', action: () => sftp.upload(menu.entry.path) }] : [{ icon: <Edit3 size={14} />, label: 'Edit Text', action: () => sftp.edit(menu.entry.path) }]), { icon: <Download size={14} />, label: 'Download', action: () => sftp.download(menu.entry) }, { icon: <Copy size={14} />, label: 'Copy Path', action: () => sftp.copyPath(menu.entry.path) }, { icon: <Info size={14} />, label: 'Properties', action: () => sftp.properties(menu.entry.path) }, { icon: <Trash2 size={14} />, label: 'Delete', danger: true, action: () => sftp.deleteEntry(menu.entry) }]} />}
	</aside>;
}

function Menu({ items, className, style }: { items: { icon: React.ReactNode; label: string; danger?: boolean; action: () => void }[]; className: string; style?: React.CSSProperties }) { return <div className={`z-30 min-w-44 border border-(--vscode-menu-border,var(--vscode-panel-border)) bg-(--vscode-menu-background) p-1 text-(--vscode-menu-foreground) shadow-lg ${className}`} style={style}>{items.map(item => <button key={item.label} className={`grid min-h-7 w-full grid-cols-[20px_1fr] items-center border-0 bg-transparent px-2 text-left hover:bg-(--vscode-menu-selectionBackground) hover:text-(--vscode-menu-selectionForeground) ${item.danger ? 'text-(--vscode-errorForeground)' : ''}`} onClick={event => { event.stopPropagation(); item.action(); }}>{item.icon}<span>{item.label}</span></button>)}</div>; }
function Status({ children }: { children: React.ReactNode }) { return <div className="absolute inset-0 flex items-center justify-center bg-(--vscode-editor-background)/65 p-6 text-center text-xs text-(--vscode-descriptionForeground)">{children}</div>; }
function formatFileSize(bytes: number) { if (bytes < 1024) return `${bytes} B`; const units = ['KB','MB','GB','TB']; let value = bytes / 1024; let unit = units[0]; for (let index = 1; index < units.length && value >= 1024; index++) { value /= 1024; unit = units[index]; } return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`; }