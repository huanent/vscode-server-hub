import { useEffect, useRef, useState } from 'react';
import { vscode } from '../../../vscodeApi';
import type { ContainerExtensionMessage, ResourceRow, ResourceType, ServiceState } from '../types';

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
		server, resource, rows, serviceState, serviceMessage, loading, error, systemPending, containerPendingId, details,
		setResource, refresh: () => vscode.postMessage({ type: 'load', resource }),
		systemAction: () => vscode.postMessage({ type: 'systemAction', action: serviceState === 'running' ? 'stop' : 'start' }),
		containerAction: (id: string, action: 'start' | 'stop') => vscode.postMessage({ type: 'containerAction', id, action }),
		inspect: (row: ResourceRow) => { setDetails({ title: row.name, content: 'Loading details...' }); vscode.postMessage({ type: 'inspect', resource, id: row.id }); },
		closeDetails: () => setDetails(undefined),
	};
}