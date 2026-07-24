export type ServerType = 'ssh' | 'mysql' | 'container';
export type AuthType = 'password' | 'privateKey';
export type Runtime = 'docker' | 'podman' | 'apple';

export interface Server {
	type: ServerType;
	name: string;
	group: string;
	host?: string;
	port?: number;
	username?: string;
	authType?: AuthType;
	proxyCommand?: string;
	database?: string;
	runtime?: Runtime;
	executablePath?: string;
}

export interface InitialData {
	serverType: ServerType;
	groups: string[];
	server?: Server;
	credentials: {
		password?: string;
		privateKey?: string;
		passphrase?: string;
	};
	isEditing: boolean;
	title: string;
	description: string;
}

export interface FormValues {
	name: string;
	group: string;
	host: string;
	port: string;
	username: string;
	authType: string;
	proxyCommand: string;
	password: string;
	privateKey: string;
	passphrase: string;
	database: string;
	runtime: string;
	executablePath: string;
}

export interface FormFieldsProps {
	values: FormValues;
	setValue(name: keyof FormValues, value: string): void;
}