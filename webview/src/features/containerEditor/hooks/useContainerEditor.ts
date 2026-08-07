import { useEffect, useRef, useState } from 'react';
import { vscode } from '../../../vscodeApi';
import type { ContainerExtensionMessage, ContainerRecreateConfig, ResourceRow, ResourceType, ServiceState } from '../types';

export function useContainerEditor() {
	const [server, setServer] = useState<{ name: string; runtime: 'docker' | 'podman' | 'apple'; executablePath: string }>();
	const [resource, setResourceState] = useState<ResourceType>('containers');
	const [rows, setRows] = useState<ResourceRow[]>([]);
	const [serviceState, setServiceState] = useState<ServiceState>('checking');
	const [serviceMessage, setServiceMessage] = useState('');
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');
	const [systemPending, setSystemPending] = useState(false);
	const [containerPendingId, setContainerPendingId] = useState('');
	const [details, setDetails] = useState<{ title: string; content: string }>();
	const [containerEditor, setContainerEditor] = useState<{ id: string; config?: ContainerRecreateConfig; loading: boolean; saving: boolean; error: string }>();
	const resourceRef = useRef(resource);
	resourceRef.current = resource;

	useEffect(() => {
		const handleMessage = (event: MessageEvent<ContainerExtensionMessage>) => {
			const message = event.data;
			switch (message.type) {
				case 'initialize': setServer(message.server); break;
				case 'serviceStatus': setServiceState(message.state); setServiceMessage(message.message ?? ''); break;
				case 'systemActionPending': setSystemPending(true); setServiceMessage(message.action === 'start' ? 'Starting...' : 'Stopping...'); break;
				case 'systemActionComplete': setSystemPending(false); break;
				case 'loading': if (message.resource === resourceRef.current) { setLoading(true); setError(''); } break;
				case 'resource': if (message.resource === resourceRef.current) { setRows(message.rows); setLoading(false); setError(''); setContainerPendingId(''); } break;
				case 'error': if (message.resource === resourceRef.current) { setLoading(false); setError(message.message); } break;
				case 'containerActionPending': setContainerPendingId(message.id); break;
				case 'containerActionComplete': setContainerPendingId(''); break;
				case 'containerActionError': setContainerPendingId(''); setError(message.message); break;
				case 'containerConfig': setContainerEditor(current => current?.id === message.id ? { ...current, config: message.config, loading: false, error: '' } : current); break;
				case 'containerConfigError': setContainerEditor(current => current?.id === message.id ? { ...current, loading: false, error: message.message } : current); break;
				case 'containerRecreatePending': setContainerEditor(current => current?.id === message.id ? { ...current, saving: true, error: '' } : current); break;
				case 'containerRecreateComplete': setContainerEditor(undefined); break;
				case 'containerRecreateError': setContainerEditor(current => current?.id === message.id ? { ...current, saving: false, error: message.message } : current); break;
				case 'details': setDetails(current => current ? { ...current, content: JSON.stringify(message.details, null, 2) } : current); break;
				case 'detailsError': setDetails(current => current ? { ...current, content: message.message } : current); break;
			}
		};
		window.addEventListener('message', handleMessage);
		vscode.postMessage({ type: 'ready' });
		return () => window.removeEventListener('message', handleMessage);
	}, []);

	const setResource = (next: ResourceType) => {
		setResourceState(next);
		setDetails(undefined);
		setLoading(true);
		setError('');
		vscode.postMessage({ type: 'load', resource: next });
	};
	return {
		server, resource, rows, serviceState, serviceMessage, loading, error, systemPending, containerPendingId, details, containerEditor,
		setResource, refresh: () => vscode.postMessage({ type: 'load', resource }),
		systemAction: () => vscode.postMessage({ type: 'systemAction', action: serviceState === 'running' ? 'stop' : 'start' }),
		containerAction: (id: string, action: 'start' | 'stop') => vscode.postMessage({ type: 'containerAction', id, action }),
		editContainer: (id: string) => { setContainerEditor({ id, loading: true, saving: false, error: '' }); vscode.postMessage({ type: 'editContainer', id }); },
		updateContainerConfig: <Key extends keyof ContainerRecreateConfig>(key: Key, value: ContainerRecreateConfig[Key]) => setContainerEditor(current => current?.config ? { ...current, config: { ...current.config, [key]: value } } : current),
		recreateContainer: () => { if (containerEditor?.config) vscode.postMessage({ type: 'recreateContainer', id: containerEditor.id, config: containerEditor.config }); },
		closeContainerEditor: () => { if (!containerEditor?.saving) setContainerEditor(undefined); },
		inspect: (row: ResourceRow) => { setDetails({ title: row.name, content: 'Loading details...' }); vscode.postMessage({ type: 'inspect', resource, id: row.id }); },
		closeDetails: () => setDetails(undefined),
	};
}