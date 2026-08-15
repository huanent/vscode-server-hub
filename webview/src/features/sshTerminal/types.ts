export interface SftpEntry { name: string; path: string; isDirectory: boolean; size: number; modifiedAt: number }
export interface RemoteMetricsDisplay { cpu: string; memory: string; disk: string; network: string }
export type ConnectionStatus = 'connecting' | 'connected' | 'closed' | 'error';

export type SshExtensionMessage =
	| { type: 'initialize'; server: { name: string; address: string } }
	| { type: 'status'; status: ConnectionStatus; message: string }
	| { type: 'output'; data: string }
	| { type: 'metrics'; metrics: RemoteMetricsDisplay }
	| { type: 'metricsUnavailable' }
	| { type: 'focusTerminal' }
	| { type: 'showSftp' }
	| { type: 'hideSftp' }
	| { type: 'sftpLoading'; path: string }
	| { type: 'sftpEntries'; path: string; parentPath: string | null; entries: SftpEntry[] }
	| { type: 'sftpError' }
	| { type: 'sftpFavorites'; favorites: string[] };