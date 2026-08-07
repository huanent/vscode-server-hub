export type ResourceType = 'containers' | 'images' | 'volumes' | 'networks';
export type ServiceState = 'checking' | 'running' | 'stopped' | 'error';

export interface ResourceRow {
	id: string;
	name: string;
	status: string;
	detail: string;
	size: string;
}

export interface ContainerRecreateConfig {
	name: string;
	image: string;
	entrypoint: string;
	command: string;
	environment: string;
	ports: string;
	sockets: string;
	volumes: string;
	mounts: string;
	tmpfs: string;
	networks: string;
	labels: string;
	dnsServers: string;
	dnsSearch: string;
	dnsOptions: string;
	capAdd: string;
	capDrop: string;
	ulimits: string;
	workingDirectory: string;
	user: string;
	restartPolicy: string;
	cpus: string;
	memory: string;
	platform: string;
	runtime: string;
	shmSize: string;
	interactive: boolean;
	tty: boolean;
	readOnly: boolean;
	init: boolean;
	rosetta: boolean;
	ssh: boolean;
	virtualization: boolean;
}

export type ContainerExtensionMessage =
	| { type: 'initialize'; server: { name: string; runtime: 'docker' | 'podman' | 'apple'; executablePath: string } }
	| { type: 'serviceStatus'; state: ServiceState; message?: string }
	| { type: 'systemActionPending'; action: 'start' | 'stop' }
	| { type: 'systemActionComplete' }
	| { type: 'loading'; resource: ResourceType }
	| { type: 'resource'; resource: ResourceType; rows: ResourceRow[] }
	| { type: 'error'; resource: ResourceType; message: string }
	| { type: 'containerActionPending'; id: string; action: 'start' | 'stop' }
	| { type: 'containerActionComplete'; id: string }
	| { type: 'containerActionError'; id: string; message: string }
	| { type: 'containerConfig'; id: string; config: ContainerRecreateConfig }
	| { type: 'containerConfigError'; id: string; message: string }
	| { type: 'containerRecreatePending'; id: string }
	| { type: 'containerRecreateComplete'; id: string }
	| { type: 'containerRecreateError'; id: string; message: string }
	| { type: 'details'; resource: ResourceType; id: string; details: unknown }
	| { type: 'detailsError'; message: string };