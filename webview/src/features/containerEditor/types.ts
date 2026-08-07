export type ResourceType = 'containers' | 'images' | 'volumes' | 'networks';
export type ServiceState = 'checking' | 'running' | 'stopped' | 'error';

export interface ResourceRow {
	id: string;
	name: string;
	status: string;
	detail: string;
	size: string;
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
	| { type: 'details'; resource: ResourceType; id: string; details: unknown }
	| { type: 'detailsError'; message: string };