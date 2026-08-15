import { useEffect, useState } from 'react';
import { ArrowUp, File, Folder, FolderOpen, LoaderCircle, MoreHorizontal, RefreshCw, Star, X } from '../../components/icons';
import { IconButton } from '../../components/button';
import { TextInput } from '../../components/input';
import type { SftpEntry } from './types';

interface SftpActions {
	sftpPath: string;
	parentPath: string | null;
	entries: SftpEntry[];
	favorites: string[];
	loading: boolean;
	list: (path: string) => void;
	toggleFavorite: (path?: string) => void;
	createDirectory: (path?: string) => void;
	upload: (path?: string) => void;
	properties: (path?: string) => void;
	download: (entry: SftpEntry) => void;
	deleteEntry: (entry: SftpEntry) => void;
	copyPath: (path: string) => void;
	edit: (path: string) => void;
}

interface ContextMenuState {
	entry: SftpEntry;
	x: number;
	y: number;
}

const popupClassName = 'rounded-[4px] border border-(--vscode-menu-border,var(--vscode-widget-border,var(--vscode-panel-border))) bg-(--vscode-menu-background) p-1 text-(--vscode-menu-foreground) shadow-[0_4px_14px_var(--vscode-widget-shadow)]';
const fileGridClassName = 'grid grid-cols-[minmax(140px,1fr)_76px_116px] items-center max-[760px]:grid-cols-[minmax(130px,1fr)_72px]';
const dateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function SftpPanel({ sftp }: { sftp: SftpActions }) {
	const [pathValue, setPathValue] = useState(sftp.sftpPath);
	const [showFavorites, setShowFavorites] = useState(false);
	const [showMore, setShowMore] = useState(false);
	const [menu, setMenu] = useState<ContextMenuState>();

	useEffect(() => setPathValue(sftp.sftpPath), [sftp.sftpPath]);
	useEffect(() => {
		const closePopups = () => {
			setShowFavorites(false);
			setShowMore(false);
			setMenu(undefined);
		};
		window.addEventListener('blur', closePopups);
		window.addEventListener('click', closePopups);
		return () => {
			window.removeEventListener('blur', closePopups);
			window.removeEventListener('click', closePopups);
		};
	}, []);

	const favorite = sftp.favorites.includes(sftp.sftpPath);

	return <aside className="grid min-h-0 min-w-0 grid-rows-[38px_26px_minmax(0,1fr)] border-l border-(--vscode-panel-border,var(--vscode-widget-border)) bg-(--vscode-editor-background) select-none" aria-label="SFTP file browser">
		<header className="flex min-w-0 items-center gap-1 border-b border-(--vscode-panel-border,var(--vscode-widget-border)) px-1.5 py-1">
			<IconButton className="size-7 border-0" disabled={!sftp.parentPath || sftp.loading} title="Parent directory" onClick={() => sftp.parentPath && sftp.list(sftp.parentPath)}><ArrowUp size={15} /></IconButton>
			<IconButton className="size-7 border-0" disabled={sftp.loading} title="Refresh" onClick={() => sftp.list(sftp.sftpPath)}><RefreshCw className={sftp.loading ? 'codicon-modifier-spin' : ''} size={15} /></IconButton>
			<div className="relative flex min-w-0 flex-1 items-center overflow-visible rounded-[3px] border border-(--vscode-input-border,var(--vscode-widget-border,var(--vscode-panel-border))) bg-(--vscode-input-background) focus-within:border-(--vscode-focusBorder) focus-within:shadow-[0_0_0_1px_var(--vscode-focusBorder)]" onClick={event => event.stopPropagation()} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setShowFavorites(false); }}>
				<TextInput aria-label="Remote path" className="h-6 min-w-0 border-0 bg-transparent px-2 font-(family-name:--vscode-editor-font-family) text-[11px] shadow-none focus:border-transparent" disabled={sftp.loading} spellCheck={false} value={pathValue} onFocus={() => setShowFavorites(true)} onChange={event => setPathValue(event.target.value)} onKeyDown={event => {
					if (event.key === 'Enter' && pathValue.trim()) {
						sftp.list(pathValue.trim());
						setShowFavorites(false);
					}
					if (event.key === 'Escape') {
						setPathValue(sftp.sftpPath);
						setShowFavorites(false);
					}
				}} />
				<IconButton className={`mr-0.5 size-5 border-0 ${favorite ? 'text-(--vscode-charts-yellow)' : 'text-(--vscode-descriptionForeground)'}`} title={favorite ? 'Remove from favorites' : 'Add to favorites'} onClick={event => { event.stopPropagation(); sftp.toggleFavorite(); }}><Star size={12} fill={favorite ? 'currentColor' : 'none'} /></IconButton>
				{showFavorites && sftp.favorites.length > 0 && <Favorites paths={sftp.favorites} activePath={sftp.sftpPath} onSelect={path => { sftp.list(path); setShowFavorites(false); }} onRemove={path => sftp.toggleFavorite(path)} />}
			</div>
			<div className="relative" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setShowMore(false); }}>
				<IconButton className={`size-7 border-0 ${showMore ? 'bg-(--vscode-toolbar-activeBackground,var(--vscode-toolbar-hoverBackground))' : ''}`} title="More actions" aria-expanded={showMore} onClick={event => { event.stopPropagation(); setShowMore(current => !current); }}><MoreHorizontal size={16} /></IconButton>
				{showMore && <Menu className="absolute top-8 right-0" onDismiss={() => setShowMore(false)} items={[{ label: 'New Folder', action: () => sftp.createDirectory() }, { label: 'Upload Files', action: () => sftp.upload() }, { label: 'Properties', action: () => sftp.properties() }]} />}
			</div>
		</header>

		<div className={`${fileGridClassName} border-b border-(--vscode-panel-border,var(--vscode-widget-border)) px-2.5 text-[10px] font-semibold text-(--vscode-descriptionForeground)`}>
			<span>Name</span>
			<span className="text-right">Size</span>
			<span className="text-right max-[760px]:hidden">Modified</span>
		</div>

		<div className="relative min-h-0 overflow-hidden">
			<div className="h-full overflow-auto py-1">
				{sftp.entries.map(entry => <FileRow key={entry.path} entry={entry} active={menu?.entry.path === entry.path} onOpen={() => entry.isDirectory && sftp.list(entry.path)} onContextMenu={(x, y) => setMenu({ entry, x, y })} />)}
			</div>
			{sftp.loading ? <Status icon={<LoaderCircle className="codicon-modifier-spin" size={18} />} title="Loading directory" detail={sftp.sftpPath} /> : sftp.entries.length === 0 && <Status icon={<FolderOpen size={20} />} title="This folder is empty" detail="Upload a file or create a new folder." />}
		</div>

		{menu && <Menu className="fixed" style={{ left: Math.max(4, Math.min(menu.x, window.innerWidth - 190)), top: Math.max(4, Math.min(menu.y, window.innerHeight - 210)) }} onDismiss={() => setMenu(undefined)} items={[
			...(menu.entry.isDirectory ? [{ label: 'New Folder', action: () => sftp.createDirectory(menu.entry.path) }, { label: 'Upload Files', action: () => sftp.upload(menu.entry.path) }] : [{ label: 'Edit Text', action: () => sftp.edit(menu.entry.path) }]),
			{ label: 'Download', action: () => sftp.download(menu.entry) },
			{ label: 'Copy Path', action: () => sftp.copyPath(menu.entry.path) },
			{ label: 'Properties', action: () => sftp.properties(menu.entry.path) },
			{ label: 'Delete', danger: true, action: () => sftp.deleteEntry(menu.entry) },
		]} />}
	</aside>;
}

function Favorites({ paths, activePath, onSelect, onRemove }: { paths: string[]; activePath: string; onSelect: (path: string) => void; onRemove: (path: string) => void }) {
	return <div className={`${popupClassName} absolute top-[calc(100%+5px)] right-0 left-0 z-20 max-h-56 min-w-52 overflow-auto`} role="listbox">
		{paths.map(path => <div key={path} className={`group flex min-h-7 items-center rounded-[3px] hover:bg-(--vscode-list-hoverBackground) focus-within:bg-(--vscode-list-hoverBackground) ${path === activePath ? 'text-(--vscode-textLink-foreground)' : ''}`} role="option" aria-selected={path === activePath}>
			<button className="min-w-0 flex-1 overflow-hidden border-0 bg-transparent px-2 text-left font-(family-name:--vscode-editor-font-family) text-[11px] text-ellipsis whitespace-nowrap outline-none" title={path} onClick={() => onSelect(path)}>{path}</button>
			<button className="mr-0.5 grid size-5 shrink-0 place-items-center rounded-xs border-0 bg-transparent text-(--vscode-icon-foreground) opacity-0 outline-none hover:bg-(--vscode-toolbar-hoverBackground) focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100" title="Remove from favorites" aria-label={`Remove ${path} from favorites`} onClick={event => { event.stopPropagation(); onRemove(path); }}><X size={12} /></button>
		</div>)}
	</div>;
}

function FileRow({ entry, active, onOpen, onContextMenu }: { entry: SftpEntry; active: boolean; onOpen: () => void; onContextMenu: (x: number, y: number) => void }) {
	return <div className={`${fileGridClassName} min-h-8 border-l-2 px-2 hover:bg-(--vscode-list-hoverBackground) ${active ? 'border-l-(--vscode-focusBorder) bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground)' : 'border-l-transparent'}`} tabIndex={0} title={entry.path} onDoubleClick={onOpen} onKeyDown={event => { if (event.key === 'Enter' && entry.isDirectory) onOpen(); }} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onContextMenu(event.clientX, event.clientY); }}>
		<span className="flex min-w-0 items-center gap-2">
			{entry.isDirectory ? <Folder className="shrink-0 text-(--vscode-symbolIcon-folderForeground,var(--vscode-icon-foreground))" size={15} /> : <File className="shrink-0 text-(--vscode-symbolIcon-fileForeground,var(--vscode-icon-foreground))" size={15} />}
			<span className="overflow-hidden text-[11px] text-ellipsis whitespace-nowrap">{entry.name}</span>
		</span>
		<span className="overflow-hidden text-right font-(family-name:--vscode-editor-font-family) text-[10px] text-ellipsis whitespace-nowrap text-(--vscode-descriptionForeground)">{entry.isDirectory ? '-' : formatFileSize(entry.size)}</span>
		<span className="overflow-hidden text-right text-[10px] text-ellipsis whitespace-nowrap text-(--vscode-descriptionForeground) max-[760px]:hidden">{dateFormatter.format(new Date(entry.modifiedAt))}</span>
	</div>;
}

function Menu({ items, className, style, onDismiss }: { items: { label: string; danger?: boolean; action: () => void }[]; className: string; style?: React.CSSProperties; onDismiss: () => void }) {
	return <div className={`${popupClassName} z-30 min-w-44 ${className}`} style={style} tabIndex={-1} autoFocus role="menu" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onDismiss(); } }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) onDismiss(); }}>
		{items.map(item => <button key={item.label} className={`block min-h-7.5 w-full rounded-[3px] border-0 bg-transparent px-2.5 text-left text-xs outline-none hover:bg-(--vscode-menu-selectionBackground) hover:text-(--vscode-menu-selectionForeground) focus:bg-(--vscode-menu-selectionBackground) focus:text-(--vscode-menu-selectionForeground) ${item.danger ? 'text-(--vscode-errorForeground)' : ''}`} role="menuitem" onClick={event => { event.stopPropagation(); item.action(); onDismiss(); }}>{item.label}</button>)}
	</div>;
}

function Status({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) {
	return <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-[color-mix(in_srgb,var(--vscode-editor-background)_90%,transparent)] p-6 text-center text-(--vscode-descriptionForeground)">
		<span className="text-(--vscode-icon-foreground)">{icon}</span>
		<strong className="text-[11px] font-semibold text-(--vscode-foreground)">{title}</strong>
		<span className="max-w-60 overflow-hidden text-[10px] text-ellipsis whitespace-nowrap">{detail}</span>
	</div>;
}

function formatFileSize(bytes: number) {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1024;
	let unit = units[0];
	for (let index = 1; index < units.length && value >= 1024; index++) {
		value /= 1024;
		unit = units[index];
	}
	return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}