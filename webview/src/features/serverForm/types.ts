export type ServerType = 'ssh' | 'mysql' | 'container';
export type AuthType = 'password' | 'privateKey';
export type ContainerRuntime = 'docker' | 'podman' | 'apple';
export type ConnectionType = 'local' | 'ssh';

export interface ServerCommand {
	name: string;
	value: string;
}

interface BaseServer {
	id: string;
	type: ServerType;
	name: string;
	group: string;
}

export interface SshServer extends BaseServer {
	type: 'ssh';
	host: string;
	port: number;
	username: string;
	authType: AuthType;
	proxyCommand?: string;
	proxy?: SshProxy;
	commands: ServerCommand[];
}

export interface SshProxy {
	host: string;
	port: number;
	username: string;
	authType: AuthType;
}

export interface MysqlServer extends BaseServer {
	type: 'mysql';
	host: string;
	port: number;
	username: string;
	database: string;
}

export interface ContainerServer extends BaseServer {
	type: 'container';
	runtime: ContainerRuntime;
	executablePath: string;
	connectionType: ConnectionType;
	sshServerId?: string;
	host?: string;
	port?: number;
	username?: string;
	authType?: AuthType;
	proxyCommand?: string;
	proxy?: SshProxy;
}

export type Server = SshServer | MysqlServer | ContainerServer;

export interface ServerCredentials {
	password?: string;
	privateKey?: string;
	passphrase?: string;
	proxyPassword?: string;
	proxyPrivateKey?: string;
	proxyPassphrase?: string;
}

export interface ServerFormModel {
	serverType: ServerType;
	server?: Server;
	credentials: ServerCredentials;
	groups: string[];
	sshServers: SshServer[];
}

export interface ServerFormValues {
	name: string;
	group: string;
	host: string;
	port: string;
	username: string;
	authType: AuthType;
	proxyCommand: string;
	proxyEnabled: boolean;
	proxyHost: string;
	proxyPort: string;
	proxyUsername: string;
	proxyAuthType: AuthType;
	proxyPassword: string;
	proxyPrivateKey: string;
	proxyPassphrase: string;
	password: string;
	privateKey: string;
	passphrase: string;
	database: string;
	runtime: ContainerRuntime;
	executablePath: string;
	connectionType: ConnectionType;
	sshServerId: string;
	commands: ServerCommand[];
}

export type ServerFormExtensionMessage =
	| { type: 'initialize'; model: ServerFormModel }
	| { type: 'executableSelected'; path: string }
	| { type: 'privateKeySelected'; contents: string }
	| { type: 'proxyPrivateKeySelected'; contents: string }
	| { type: 'error'; message: string };