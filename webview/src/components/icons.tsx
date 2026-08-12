import type { HTMLAttributes } from 'react';
import { Codicon } from './codicon';

type IconProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & { size?: number; fill?: string };

function icon(name: string) {
	return function Icon({ fill: _fill, ...props }: IconProps) {
		return <Codicon name={name} {...props} />;
	};
}

export const ArrowDown = icon('arrow-down');
export const ArrowUp = icon('arrow-up');
export const Boxes = icon('vm');
export const ChevronsUpDown = icon('arrow-swap');
export const CircleAlert = icon('warning');
export const CircleCheck = icon('check');
export const CircleSlash = icon('circle-slash');
export const Container = icon('server-process');
export const Copy = icon('copy');
export const Database = icon('database');
export const Download = icon('cloud-download');
export const Edit3 = icon('edit');
export const File = icon('file');
export const Folder = icon('folder');
export const FolderOpen = icon('folder-opened');
export const FolderPlus = icon('new-folder');
export const Grid2X2 = icon('layout');
export const Info = icon('info');
export const KeyRound = icon('key');
export const List = icon('list-flat');
export const LoaderCircle = icon('loading');
export const MoreHorizontal = icon('ellipsis');
export const Network = icon('globe');
export const Package = icon('package');
export const Pencil = icon('edit');
export const Play = icon('play');
export const Plus = icon('add');
export const RefreshCw = icon('refresh');
export const RotateCw = icon('sync');
export const Save = icon('save');
export const Server = icon('server');
export const Square = icon('debug-stop');
export const Table2 = icon('table');
export const Trash2 = icon('trash');
export const Upload = icon('cloud-upload');
export const X = icon('close');

export function Star({ fill, ...props }: IconProps) {
	return <Codicon name={fill === 'currentColor' ? 'star-full' : 'star-empty'} {...props} />;
}