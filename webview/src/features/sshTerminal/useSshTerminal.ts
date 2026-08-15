import { useEffect, useRef, useState } from 'react';
import { vscode } from '../../vscodeApi';
import type { ConnectionStatus, RemoteMetricsDisplay, SftpEntry, SshExtensionMessage } from './types';

const emptyMetrics = { cpu: '--', memory: '--', disk: '--', network: '--' };

export function useSshTerminal(onOutput: (data: string) => void, onVisibilityChange: () => void, onFocus: () => void) {
	const onOutputRef = useRef(onOutput);
	const onVisibilityChangeRef = useRef(onVisibilityChange);
	const onFocusRef = useRef(onFocus);
	onOutputRef.current = onOutput;
	onVisibilityChangeRef.current = onVisibilityChange;
	onFocusRef.current = onFocus;
	const [server, setServer] = useState<{ name: string; address: string }>();
	const [status, setStatus] = useState<ConnectionStatus>('connecting');
	const [statusMessage, setStatusMessage] = useState('Preparing terminal');
	const [metrics, setMetrics] = useState<RemoteMetricsDisplay>(emptyMetrics);
	const [sftpVisible, setSftpVisible] = useState(false);
	const [sftpPath, setSftpPath] = useState('.');
	const [parentPath, setParentPath] = useState<string | null>(null);
	const [entries, setEntries] = useState<SftpEntry[]>([]);
	const [favorites, setFavorites] = useState<string[]>([]);
	const [sftpLoading, setSftpLoading] = useState(false);

	useEffect(() => {
		const handleMessage = (event: MessageEvent<SshExtensionMessage>) => {
			const message = event.data;
			switch (message.type) {
				case 'initialize': setServer(message.server); break;
				case 'status': setStatus(message.status); setStatusMessage(message.message); break;
				case 'output': onOutputRef.current(message.data); break;
				case 'metrics': setMetrics(message.metrics); break;
				case 'metricsUnavailable': setMetrics(emptyMetrics); break;
				case 'focusTerminal': onFocusRef.current(); break;
				case 'showSftp': setSftpVisible(true); requestAnimationFrame(() => onVisibilityChangeRef.current()); break;
				case 'hideSftp': setSftpVisible(false); requestAnimationFrame(() => onVisibilityChangeRef.current()); break;
				case 'sftpLoading': setSftpLoading(true); break;
				case 'sftpEntries': setSftpPath(message.path); setParentPath(message.parentPath); setEntries(message.entries); setSftpLoading(false); break;
				case 'sftpFavorites': setFavorites(message.favorites); break;
				case 'sftpError': setSftpLoading(false); break;
			}
		};
		window.addEventListener('message', handleMessage);
		return () => window.removeEventListener('message', handleMessage);
	}, []);

	const postPath = (type: string, path: string, extra?: object) => vscode.postMessage({ type, path, ...extra });
	return {
		server, status, statusMessage, metrics, sftpVisible, sftpPath, parentPath, entries, favorites, sftpLoading,
		ready: () => vscode.postMessage({ type: 'ready' }), input: (data: string) => vscode.postMessage({ type: 'input', data }), resize: (rows: number, columns: number) => vscode.postMessage({ type: 'resize', rows, columns }),
		list: (path: string) => postPath('sftpList', path), toggleFavorite: (path = sftpPath) => postPath('sftpToggleFavorite', path),
		createDirectory: (path = sftpPath) => postPath('sftpCreateDirectory', path), upload: (path = sftpPath) => postPath('sftpUpload', path), properties: (path = sftpPath) => postPath('sftpProperties', path),
		download: (entry: SftpEntry) => postPath('sftpDownload', entry.path, { isDirectory: entry.isDirectory }), deleteEntry: (entry: SftpEntry) => postPath('sftpDelete', entry.path, { isDirectory: entry.isDirectory }),
		copyPath: (path: string) => postPath('sftpCopyPath', path), edit: (path: string) => postPath('sftpEdit', path),
	};
}