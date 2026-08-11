import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { ContainerServer, SshServer } from '../servers/server';
import { ServerStore } from '../servers/serverStore';
import { executeSshCommand } from '../ssh/sshCommand';
import { getWebviewHtml } from '../webview';

const execFileAsync = promisify(execFile);

type ResourceType = 'containers' | 'images' | 'volumes' | 'networks';

interface ContainerEditorMessage {
	type: 'ready' | 'load' | 'inspect' | 'editContainer' | 'recreateContainer' | 'systemAction' | 'containerAction';
	resource?: unknown;
	id?: unknown;
	action?: unknown;
	config?: unknown;
}

type ServiceState = 'checking' | 'running' | 'stopped' | 'error';

interface ResourceRow {
	id: string;
	name: string;
	status: string;
	detail: string;
	size: string;
}

interface ContainerRecreateConfig {
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

export function configureContainerEditor(
	extensionUri: vscode.Uri,
	panel: vscode.WebviewPanel,
	server: ContainerServer,
	serverStore: ServerStore,
): void {
	panel.title = server.name;
	panel.iconPath = new vscode.ThemeIcon('server-process');
	panel.webview.options = {
		enableScripts: true,
		localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
	};
	panel.webview.html = getWebviewHtml(panel.webview, extensionUri, 'containerEditor', server.name);

	panel.webview.onDidReceiveMessage(async (message: ContainerEditorMessage) => {
		if (message.type === 'ready') {
			await panel.webview.postMessage({
				type: 'initialize',
				server: { name: server.name, runtime: server.runtime, executablePath: server.executablePath },
			});
			await refreshServiceStatus();
			await loadResource('containers');
			return;
		}
		if (message.type === 'load' && isResourceType(message.resource)) {
			await loadResource(message.resource);
			return;
		}
		if (message.type === 'systemAction'
			&& server.runtime === 'apple'
			&& (message.action === 'start' || message.action === 'stop')) {
			await changeAppleSystemState(message.action);
			return;
		}
		if (message.type === 'containerAction'
			&& typeof message.id === 'string'
			&& (message.action === 'start' || message.action === 'stop')) {
			await changeContainerState(message.id, message.action);
			return;
		}
		if (message.type === 'editContainer' && typeof message.id === 'string') {
			await loadContainerConfig(message.id);
			return;
		}
		if (message.type === 'recreateContainer'
			&& typeof message.id === 'string'
			&& isContainerRecreateConfig(message.config)) {
			await recreateContainer(message.id, message.config);
			return;
		}
		if (message.type === 'inspect' && isResourceType(message.resource) && typeof message.id === 'string') {
			await inspectResource(message.resource, message.id);
		}
	});

	async function refreshServiceStatus(): Promise<void> {
		void panel.webview.postMessage({ type: 'serviceStatus', state: 'checking' satisfies ServiceState });
		try {
			const state = await readServiceState(server, serverStore);
			void panel.webview.postMessage({ type: 'serviceStatus', state });
		} catch (error) {
			void panel.webview.postMessage({ type: 'serviceStatus', state: 'error' satisfies ServiceState, message: errorMessage(error) });
		}
	}

	async function changeAppleSystemState(action: 'start' | 'stop'): Promise<void> {
		void panel.webview.postMessage({ type: 'systemActionPending', action });
		try {
			await executeContainerCommand(server, serverStore, action === 'start'
				? ['system', 'start', '--disable-kernel-install']
				: ['system', 'stop']);
			await refreshServiceStatus();
			if (action === 'start') {
				await loadResource('containers');
			}
		} catch (error) {
			void panel.webview.postMessage({
				type: 'serviceStatus',
				state: 'error' satisfies ServiceState,
				message: errorMessage(error),
			});
		} finally {
			void panel.webview.postMessage({ type: 'systemActionComplete' });
		}
	}

	async function loadResource(resource: ResourceType): Promise<void> {
		void panel.webview.postMessage({ type: 'loading', resource });
		try {
			const rows = await listResource(server, serverStore, resource);
			void panel.webview.postMessage({ type: 'resource', resource, rows });
		} catch (error) {
			void panel.webview.postMessage({ type: 'error', resource, message: errorMessage(error) });
		}
	}

	async function changeContainerState(id: string, action: 'start' | 'stop'): Promise<void> {
		void panel.webview.postMessage({ type: 'containerActionPending', id, action });
		try {
			await executeContainerCommand(server, serverStore, [action, id]);
			await loadResource('containers');
		} catch (error) {
			void panel.webview.postMessage({ type: 'containerActionError', id, message: errorMessage(error) });
		} finally {
			void panel.webview.postMessage({ type: 'containerActionComplete', id });
		}
	}

	async function loadContainerConfig(id: string): Promise<void> {
		try {
			const details = await inspectResourceDetails(server, serverStore, 'containers', id);
			void panel.webview.postMessage({ type: 'containerConfig', id, config: containerRecreateConfig(details, server.runtime) });
		} catch (error) {
			void panel.webview.postMessage({ type: 'containerConfigError', id, message: errorMessage(error) });
		}
	}

	async function recreateContainer(id: string, config: ContainerRecreateConfig): Promise<void> {
		void panel.webview.postMessage({ type: 'containerRecreatePending', id });
		try {
			if (server.runtime === 'apple') {
				await executeContainerCommand(server, serverStore, ['rm', '--force', id]);
				await executeContainerCommand(server, serverStore, createContainerArguments(server.runtime, config));
			} else {
				await safelyRecreateContainer(id, config);
			}
			void panel.webview.postMessage({ type: 'containerRecreateComplete', id });
			await loadResource('containers');
		} catch (error) {
			void panel.webview.postMessage({ type: 'containerRecreateError', id, message: errorMessage(error) });
		}
	}

	async function safelyRecreateContainer(id: string, config: ContainerRecreateConfig): Promise<void> {
		const details = await inspectResourceDetails(server, serverStore, 'containers', id);
		const inspected = Array.isArray(details) ? recordValue(details[0]) : recordValue(details);
		const originalName = stringValue(inspected, 'Name', 'name').replace(/^\//, '') || id;
		const wasRunning = Boolean(recordValue(inspected.State ?? inspected.state).Running ?? recordValue(inspected.State ?? inspected.state).running);
		const backupName = `${originalName}-server-hub-backup-${Date.now()}`;
		if (wasRunning) {
			await executeContainerCommand(server, serverStore, ['stop', id]);
		}
		await executeContainerCommand(server, serverStore, ['rename', id, backupName]);
		try {
			await executeContainerCommand(server, serverStore, createContainerArguments(server.runtime, config));
			await executeContainerCommand(server, serverStore, ['rm', '--force', backupName]);
		} catch (createError) {
			try {
				await executeContainerCommand(server, serverStore, ['rename', backupName, originalName]);
				if (wasRunning) {
					await executeContainerCommand(server, serverStore, ['start', originalName]);
				}
			} catch (restoreError) {
				throw new Error(`${errorMessage(createError)} Restore also failed: ${errorMessage(restoreError)}`);
			}
			throw createError;
		}
	}

	async function inspectResource(resource: ResourceType, id: string): Promise<void> {
		try {
			const details = await inspectResourceDetails(server, serverStore, resource, id);
			void panel.webview.postMessage({ type: 'details', resource, id, details });
		} catch (error) {
			void panel.webview.postMessage({ type: 'detailsError', message: errorMessage(error) });
		}
	}
}

async function listResource(server: ContainerServer, serverStore: ServerStore, resource: ResourceType): Promise<ResourceRow[]> {
	const output = await executeContainerCommand(server, serverStore, listArguments(server.runtime, resource));
	const values = parseListOutput(output, server.runtime);
	return values.map(value => normalizeResourceRow(server.runtime, resource, value));
}

async function inspectResourceDetails(server: ContainerServer, serverStore: ServerStore, resource: ResourceType, id: string): Promise<unknown> {
	const output = await executeContainerCommand(server, serverStore, inspectArguments(server.runtime, resource, id));
	return JSON.parse(output);
}

async function readServiceState(server: ContainerServer, serverStore: ServerStore): Promise<ServiceState> {
	if (server.runtime === 'apple') {
		const output = await executeContainerCommand(server, serverStore, ['system', 'status']);
		const match = /^status\s+(\S+)/im.exec(output);
		return match?.[1].toLowerCase() === 'running' ? 'running' : 'stopped';
	}
	await executeContainerCommand(server, serverStore, server.runtime === 'docker'
		? ['info', '--format', '{{.ServerVersion}}']
		: ['info', '--format', 'json']);
	return 'running';
}

async function executeContainerCommand(server: ContainerServer, serverStore: ServerStore, args: string[]): Promise<string> {
	if (server.connectionType === 'ssh') {
		const { sshServer, credentials } = await resolveSshConnection(server, serverStore);
		const command = [server.executablePath, ...args].map(shellQuote).join(' ');
		try {
			return await executeSshCommand(sshServer, credentials, command);
		} catch (error) {
			throw new Error(`${server.runtime} command failed: ${errorMessage(error)}`);
		}
	}
	try {
		const { stdout } = await execFileAsync(server.executablePath, args, {
			encoding: 'utf8',
			maxBuffer: 20 * 1024 * 1024,
		});
		return stdout.trim();
	} catch (error) {
		if (isExecError(error)) {
			const detail = error.stderr?.trim() || error.message;
			throw new Error(`${server.runtime} command failed: ${detail}`);
		}
		throw error;
	}
}

async function resolveSshConnection(server: ContainerServer, serverStore: ServerStore) {
	if (server.connectionType !== 'ssh') {
		throw new Error('The container server is not configured for SSH.');
	}
	if (server.sshServerId) {
		const sshServer = serverStore.getServers().find((candidate): candidate is SshServer => candidate.type === 'ssh' && candidate.id === server.sshServerId);
		if (!sshServer) {
			throw new Error('The selected SSH server no longer exists.');
		}
		return { sshServer, credentials: await serverStore.getCredentials(sshServer.id) };
	}
	if (!('authType' in server)) {
		throw new Error('The manual SSH configuration is invalid.');
	}
	const sshServer: SshServer = {
		id: server.id,
		type: 'ssh',
		name: server.name,
		group: server.group,
		host: server.host,
		port: server.port,
		username: server.username,
		authType: server.authType,
		commands: [],
		...(server.proxyCommand ? { proxyCommand: server.proxyCommand } : {}),
	};
	return { sshServer, credentials: await serverStore.getCredentials(server.id) };
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function listArguments(runtime: ContainerServer['runtime'], resource: ResourceType): string[] {
	if (runtime === 'apple') {
		switch (resource) {
			case 'containers': return ['list', '--all', '--format', 'json'];
			case 'images': return ['image', 'list', '--format', 'json'];
			case 'volumes': return ['volume', 'list', '--format', 'json'];
			case 'networks': return ['network', 'list', '--format', 'json'];
		}
	}
	if (runtime === 'podman') {
		switch (resource) {
			case 'containers': return ['ps', '--all', '--format', 'json'];
			case 'images': return ['image', 'ls', '--format', 'json'];
			case 'volumes': return ['volume', 'ls', '--format', 'json'];
			case 'networks': return ['network', 'ls', '--format', 'json'];
		}
	}
	switch (resource) {
		case 'containers': return ['ps', '--all', '--format', '{{json .}}'];
		case 'images': return ['image', 'ls', '--format', '{{json .}}'];
		case 'volumes': return ['volume', 'ls', '--format', '{{json .}}'];
		case 'networks': return ['network', 'ls', '--format', '{{json .}}'];
	}
}

function inspectArguments(runtime: ContainerServer['runtime'], resource: ResourceType, id: string): string[] {
	if (runtime === 'apple') {
		switch (resource) {
			case 'containers': return ['inspect', id];
			case 'images': return ['image', 'inspect', id];
			case 'volumes': return ['volume', 'inspect', id];
			case 'networks': return ['network', 'inspect', id];
		}
	}
	switch (resource) {
		case 'containers': return ['inspect', id];
		case 'images': return ['image', 'inspect', id];
		case 'volumes': return ['volume', 'inspect', id];
		case 'networks': return ['network', 'inspect', id];
	}
}

function containerRecreateConfig(details: unknown, runtime: ContainerServer['runtime']): ContainerRecreateConfig {
	const inspected = Array.isArray(details) ? recordValue(details[0]) : recordValue(details);
	const config = recordValue(inspected.Config ?? inspected.configuration);
	const hostConfig = recordValue(inspected.HostConfig ?? inspected.hostConfig);
	const initProcess = recordValue(config.initProcess);
	const image = recordValue(config.image);
	const restartPolicy = recordValue(hostConfig.RestartPolicy ?? hostConfig.restartPolicy);
	const resources = recordValue(config.resources);
	const platform = recordValue(config.platform);
	const dns = recordValue(config.dns);
	return {
		name: stringValue(inspected, 'Name', 'name').replace(/^\//, '') || stringValue(config, 'id', 'name'),
		image: stringValue(config, 'Image') || stringValue(image, 'reference') || stringValue(inspected, 'ImageName'),
		entrypoint: arrayLines(config.Entrypoint ?? initProcess.executable),
		command: arrayLines(config.Cmd ?? config.command ?? config.arguments ?? initProcess.arguments),
		environment: arrayLines(config.Env ?? config.environment ?? initProcess.environment),
		ports: portBindingLines(hostConfig.PortBindings ?? hostConfig.portBindings ?? config.ports ?? config.publishedPorts),
		sockets: socketBindingLines(config.publishedSockets),
		volumes: arrayLines(config.volumes),
		mounts: mountLines(runtime === 'apple' ? config.mounts : inspected.Mounts),
		tmpfs: tmpfsLines(hostConfig.Tmpfs ?? config.mounts),
		networks: networkLines(inspected.NetworkSettings ?? config.networks),
		labels: keyValueLines(config.Labels ?? config.labels),
		dnsServers: arrayLines(hostConfig.Dns ?? dns.nameservers),
		dnsSearch: arrayLines(hostConfig.DnsSearch ?? dns.searchDomains),
		dnsOptions: arrayLines(hostConfig.DnsOptions ?? dns.options),
		capAdd: arrayLines(hostConfig.CapAdd ?? config.capAdd),
		capDrop: arrayLines(hostConfig.CapDrop ?? config.capDrop),
		ulimits: ulimitLines(hostConfig.Ulimits ?? initProcess.rlimits),
		workingDirectory: stringValue(config, 'WorkingDir', 'workingDirectory') || stringValue(initProcess, 'workingDirectory'),
		user: stringValue(config, 'User') || userValue(initProcess.user),
		restartPolicy: stringValue(restartPolicy, 'Name', 'name'),
		cpus: cpuValue(hostConfig, resources),
		memory: memoryValue(hostConfig.Memory ?? resources.memoryInBytes),
		platform: platformValue(platform),
		runtime: stringValue(hostConfig, 'Runtime') || stringValue(config, 'runtimeHandler'),
		shmSize: memoryValue(hostConfig.ShmSize ?? config.shmSize),
		interactive: booleanValue(config.OpenStdin ?? initProcess.interactive),
		tty: booleanValue(config.Tty ?? initProcess.terminal),
		readOnly: booleanValue(hostConfig.ReadonlyRootfs ?? config.readOnly),
		init: booleanValue(hostConfig.Init ?? config.useInit),
		rosetta: booleanValue(config.rosetta),
		ssh: booleanValue(config.ssh),
		virtualization: booleanValue(config.virtualization),
	};
}

function createContainerArguments(runtime: ContainerServer['runtime'], config: ContainerRecreateConfig): string[] {
	const args = ['run', '--detach', '--name', config.name];
	appendFlag(args, '--entrypoint', firstLine(config.entrypoint));
	for (const value of nonEmptyLines(config.environment)) {
		args.push('--env', value);
	}
	for (const value of nonEmptyLines(config.ports)) {
		args.push('--publish', value);
	}
	if (runtime === 'apple') {
		for (const value of nonEmptyLines(config.sockets)) {
			args.push('--publish-socket', value);
		}
	}
	for (const value of nonEmptyLines(config.volumes)) {
		args.push('--volume', value);
	}
	for (const value of nonEmptyLines(config.mounts)) {
		args.push('--mount', value);
	}
	for (const value of nonEmptyLines(config.tmpfs)) {
		args.push('--tmpfs', value);
	}
	for (const value of nonEmptyLines(config.networks)) {
		args.push('--network', value);
	}
	for (const value of nonEmptyLines(config.labels)) {
		args.push('--label', value);
	}
	for (const value of nonEmptyLines(config.dnsServers)) {
		args.push('--dns', value);
	}
	for (const value of nonEmptyLines(config.dnsSearch)) {
		args.push('--dns-search', value);
	}
	for (const value of nonEmptyLines(config.dnsOptions)) {
		args.push('--dns-option', value);
	}
	for (const value of nonEmptyLines(config.capAdd)) {
		args.push('--cap-add', value);
	}
	for (const value of nonEmptyLines(config.capDrop)) {
		args.push('--cap-drop', value);
	}
	for (const value of nonEmptyLines(config.ulimits)) {
		args.push('--ulimit', value);
	}
	if (config.workingDirectory.trim()) {
		args.push('--workdir', config.workingDirectory.trim());
	}
	appendFlag(args, '--user', config.user);
	appendFlag(args, '--cpus', config.cpus);
	appendFlag(args, '--memory', config.memory);
	appendFlag(args, '--platform', config.platform);
	appendFlag(args, '--runtime', config.runtime);
	appendFlag(args, '--shm-size', config.shmSize);
	if (config.interactive) args.push('--interactive');
	if (config.tty) args.push('--tty');
	if (config.readOnly) args.push('--read-only');
	if (config.init) args.push('--init');
	if (runtime === 'apple' && config.rosetta) args.push('--rosetta');
	if (runtime === 'apple' && config.ssh) args.push('--ssh');
	if (runtime === 'apple' && config.virtualization) args.push('--virtualization');
	if (runtime !== 'apple' && config.restartPolicy.trim() && config.restartPolicy.trim() !== 'no') {
		args.push('--restart', config.restartPolicy.trim());
	}
	args.push(config.image.trim(), ...nonEmptyLines(config.command));
	return args;
}

function portBindingLines(value: unknown): string {
	if (Array.isArray(value)) {
		return value.map(portBindingValue).filter(Boolean).join('\n');
	}
	if (!isRecord(value)) {
		return '';
	}
	const ports: string[] = [];
	for (const [containerPort, bindings] of Object.entries(value)) {
		if (!Array.isArray(bindings) || bindings.length === 0) {
			continue;
		}
		for (const bindingValue of bindings) {
			const binding = recordValue(bindingValue);
			const hostPort = stringValue(binding, 'HostPort', 'hostPort');
			const hostIp = stringValue(binding, 'HostIp', 'hostIp');
			if (hostPort) {
				ports.push([hostIp && hostIp !== '0.0.0.0' ? hostIp : '', hostPort, containerPort].filter(Boolean).join(':'));
			}
		}
	}
	return ports.join('\n');
}

function portBindingValue(value: unknown): string {
	const port = recordValue(value);
	const containerPort = numberValue(port.containerPort);
	const hostPort = numberValue(port.hostPort);
	if (containerPort === undefined || hostPort === undefined) {
		return displayValue(value);
	}
	const count = numberValue(port.count) ?? 1;
	const protocol = stringValue(port, 'proto');
	const hostAddress = stringValue(port, 'hostAddress');
	const containerRange = count > 1 ? `${containerPort}-${containerPort + count - 1}` : String(containerPort);
	const hostRange = count > 1 ? `${hostPort}-${hostPort + count - 1}` : String(hostPort);
	return `${hostAddress && hostAddress !== '0.0.0.0' ? `${hostAddress}:` : ''}${hostRange}:${containerRange}${protocol && protocol !== 'tcp' ? `/${protocol}` : ''}`;
}

function networkLines(value: unknown): string {
	const networkSettings = recordValue(value);
	const networksValue = networkSettings.Networks ?? value;
	if (Array.isArray(networksValue)) {
		return networksValue.map(item => {
			const network = recordValue(item);
			const options = recordValue(network.options);
			const name = stringValue(network, 'network', 'name');
			const mac = stringValue(options, 'macAddress', 'mac');
			const mtu = displayValue(options.mtu);
			return [name, mac ? `mac=${mac}` : '', mtu ? `mtu=${mtu}` : ''].filter(Boolean).join(',');
		}).filter(Boolean).join('\n');
	}
	if (!isRecord(networksValue)) return '';
	return Object.entries(networksValue).map(([name, item]) => {
		const network = recordValue(item);
		const mac = stringValue(network, 'MacAddress');
		return [name, mac ? `mac=${mac}` : ''].filter(Boolean).join(',');
	}).join('\n');
}

function socketBindingLines(value: unknown): string {
	if (!Array.isArray(value)) return '';
	return value.map(item => {
		const socket = recordValue(item);
		const hostPath = stringValue(socket, 'hostPath', 'source');
		const containerPath = stringValue(socket, 'containerPath', 'destination');
		return hostPath && containerPath ? `${hostPath}:${containerPath}` : displayValue(item);
	}).filter(Boolean).join('\n');
}

function mountLines(value: unknown): string {
	if (!Array.isArray(value)) return '';
	return value.map(item => {
		const mount = recordValue(item);
		const typeValue = mount.Type ?? mount.type;
		const type = typeof typeValue === 'string' ? typeValue : appleMountType(typeValue);
		if (type === 'tmpfs') return '';
		const source = stringValue(mount, 'Source', 'source');
		const target = stringValue(mount, 'Destination', 'destination', 'target');
		const readOnly = mount.RW === false || booleanValue(mount.readOnly);
		return [`type=${type || 'bind'}`, source ? `source=${source}` : '', target ? `target=${target}` : '', readOnly ? 'readonly' : ''].filter(Boolean).join(',');
	}).filter(Boolean).join('\n');
}

function tmpfsLines(value: unknown): string {
	if (isRecord(value)) {
		return Object.entries(value).map(([target, options]) => options ? `${target}:${displayValue(options)}` : target).join('\n');
	}
	if (!Array.isArray(value)) return '';
	return value.map(item => {
		const mount = recordValue(item);
		return appleMountType(mount.type) === 'tmpfs' ? stringValue(mount, 'destination', 'target') : '';
	}).filter(Boolean).join('\n');
}

function appleMountType(value: unknown): string {
	const type = recordValue(value);
	if ('tmpfs' in type) return 'tmpfs';
	if ('volume' in type) return 'volume';
	if ('virtiofs' in type) return 'bind';
	return 'bind';
}

function keyValueLines(value: unknown): string {
	if (!isRecord(value)) return arrayLines(value);
	return Object.entries(value).map(([key, item]) => `${key}=${displayValue(item)}`).join('\n');
}

function ulimitLines(value: unknown): string {
	if (!Array.isArray(value)) return '';
	return value.map(item => {
		const limit = recordValue(item);
		const name = stringValue(limit, 'Name', 'name', 'type');
		const soft = displayValue(limit.Soft ?? limit.soft);
		const hard = displayValue(limit.Hard ?? limit.hard);
		return name && soft ? `${name}=${soft}${hard && hard !== soft ? `:${hard}` : ''}` : '';
	}).filter(Boolean).join('\n');
}

function userValue(value: unknown): string {
	const user = recordValue(value);
	const id = recordValue(user.id);
	const uid = displayValue(id.uid);
	const gid = displayValue(id.gid);
	return uid ? `${uid}${gid ? `:${gid}` : ''}` : '';
}

function cpuValue(hostConfig: Record<string, unknown>, resources: Record<string, unknown>): string {
	const nanoCpus = numberValue(hostConfig.NanoCpus);
	if (nanoCpus) return String(nanoCpus / 1_000_000_000);
	return displayValue(resources.cpus);
}

function memoryValue(value: unknown): string {
	const bytes = numberValue(value);
	return bytes ? String(bytes) : '';
}

function platformValue(value: Record<string, unknown>): string {
	const os = stringValue(value, 'os');
	const architecture = stringValue(value, 'architecture');
	const variant = stringValue(value, 'variant');
	return [os, architecture, variant].filter(Boolean).join('/');
}

function booleanValue(value: unknown): boolean {
	return value === true;
}

function firstLine(value: string): string {
	return nonEmptyLines(value)[0] ?? '';
}

function appendFlag(args: string[], flag: string, value: string): void {
	if (value.trim()) args.push(flag, value.trim());
}

function arrayLines(value: unknown): string {
	return Array.isArray(value) ? value.map(displayValue).filter(Boolean).join('\n') : displayValue(value);
}

function nonEmptyLines(value: string): string[] {
	return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function isContainerRecreateConfig(value: unknown): value is ContainerRecreateConfig {
	if (!isRecord(value)) {
		return false;
	}
	const name = value.name;
	const image = value.image;
	return ['name', 'image', 'entrypoint', 'command', 'environment', 'ports', 'sockets', 'volumes', 'mounts', 'tmpfs', 'networks', 'labels', 'dnsServers', 'dnsSearch', 'dnsOptions', 'capAdd', 'capDrop', 'ulimits', 'workingDirectory', 'user', 'restartPolicy', 'cpus', 'memory', 'platform', 'runtime', 'shmSize']
		.every(key => typeof value[key] === 'string')
		&& ['interactive', 'tty', 'readOnly', 'init', 'rosetta', 'ssh', 'virtualization'].every(key => typeof value[key] === 'boolean')
		&& typeof name === 'string'
		&& Boolean(name.trim())
		&& typeof image === 'string'
		&& Boolean(image.trim());
}

function parseListOutput(output: string, runtime: ContainerServer['runtime']): Record<string, unknown>[] {
	if (!output) {
		return [];
	}
	if (runtime !== 'docker') {
		const parsed: unknown = JSON.parse(output);
		if (!Array.isArray(parsed)) {
			throw new Error(`Unexpected ${runtime} list output.`);
		}
		return parsed.filter(isRecord);
	}
	return output.split(/\r?\n/).filter(Boolean).map(line => {
		const value: unknown = JSON.parse(line);
		if (!isRecord(value)) {
			throw new Error('Unexpected docker list output.');
		}
		return value;
	});
}

function normalizeResourceRow(
	runtime: ContainerServer['runtime'],
	resource: ResourceType,
	value: Record<string, unknown>,
): ResourceRow {
	if (runtime === 'apple') {
		return normalizeAppleResourceRow(resource, value);
	}
	switch (resource) {
		case 'containers': {
			const id = stringValue(value, 'ID', 'Id', 'Id', 'id');
			return {
				id,
				name: displayValue(value.Names) || stringValue(value, 'Name', 'Names') || shortId(id),
				status: stringValue(value, 'State', 'Status'),
				detail: [stringValue(value, 'Image'), stringValue(value, 'Status')].filter(Boolean).join(' · '),
				size: displayValue(value.Size),
			};
		}
		case 'images': {
			const id = stringValue(value, 'ID', 'Id', 'id');
			const repository = stringValue(value, 'Repository', 'RepoTags', 'Names');
			const tag = stringValue(value, 'Tag');
			return {
				id,
				name: tag && repository ? `${repository}:${tag}` : repository || '<none>',
				status: stringValue(value, 'CreatedSince', 'CreatedAt', 'Created'),
				detail: shortId(id),
				size: displayValue(value.Size),
			};
		}
		case 'volumes': {
			const name = stringValue(value, 'Name', 'name');
			return { id: name, name, status: stringValue(value, 'Driver', 'driver'), detail: stringValue(value, 'Mountpoint', 'Scope'), size: '' };
		}
		case 'networks': {
			const id = stringValue(value, 'ID', 'Id', 'id', 'Name');
			return { id, name: stringValue(value, 'Name', 'name') || shortId(id), status: stringValue(value, 'Driver', 'driver'), detail: stringValue(value, 'Scope', 'NetworkInterface'), size: '' };
		}
	}
}

function normalizeAppleResourceRow(resource: ResourceType, value: Record<string, unknown>): ResourceRow {
	const configuration = recordValue(value.configuration);
	const status = recordValue(value.status);
	const id = stringValue(value, 'id') || stringValue(configuration, 'id', 'name');
	switch (resource) {
		case 'containers': {
			const image = recordValue(configuration.image);
			return { id, name: stringValue(configuration, 'id') || id, status: stringValue(status, 'state'), detail: stringValue(image, 'reference'), size: '' };
		}
		case 'images': {
			const descriptor = recordValue(configuration.descriptor);
			const name = stringValue(configuration, 'name');
			return { id: name || id, name: name || shortId(id), status: stringValue(configuration, 'creationDate'), detail: shortId(id), size: formatBytes(numberValue(descriptor.size)) };
		}
		case 'volumes': return { id, name: stringValue(configuration, 'name') || id, status: stringValue(configuration, 'driver', 'format'), detail: stringValue(configuration, 'mountPoint', 'path'), size: '' };
		case 'networks': return { id, name: stringValue(configuration, 'name') || id, status: stringValue(configuration, 'plugin', 'mode'), detail: [stringValue(status, 'ipv4Subnet'), stringValue(status, 'ipv6Subnet')].filter(Boolean).join(' · '), size: '' };
	}
}

function isResourceType(value: unknown): value is ResourceType {
	return value === 'containers' || value === 'images' || value === 'volumes' || value === 'networks';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function stringValue(value: Record<string, unknown>, ...keys: string[]): string {
	for (const key of keys) {
		const result = displayValue(value[key]);
		if (result) {
			return result;
		}
	}
	return '';
}

function displayValue(value: unknown): string {
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	if (Array.isArray(value)) {
		return value.map(displayValue).filter(Boolean).join(', ');
	}
	return '';
}

function numberValue(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isExecError(error: unknown): error is Error & { stderr?: string } {
	return error instanceof Error;
}

function shortId(id: string): string {
	return id.replace(/^sha256:/, '').slice(0, 12);
}

function formatBytes(value: number | undefined): string {
	if (!value) {
		return '';
	}
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
	return `${(value / (1024 ** unit)).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(timestamp: number): string {
	return new Date(timestamp * 1000).toLocaleString();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
