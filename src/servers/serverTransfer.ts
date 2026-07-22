import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { ExportedServer, parseServerExport, Server, ServerExportFile } from './server';
import { ServerStore } from './serverStore';

export async function exportServers(serverStore: ServerStore): Promise<void> {
	const servers = serverStore.getServers();
	if (servers.length === 0) {
		void vscode.window.showInformationMessage('There are no servers to export.');
		return;
	}

	await exportServerFile(
		await serverStore.getExportedServers(),
		'server-hub-export.json',
	);
}

export async function exportServer(serverStore: ServerStore, servers: Server[]): Promise<void> {
	await exportServerFile(
		(await serverStore.getExportedServers()).filter(server => servers.some(selected => selected.id === server.id)),
		servers.length === 1 ? `${sanitizeFileName(servers[0].name)}.json` : 'server-hub-export.json',
	);
}

async function exportServerFile(servers: ExportedServer[], fileName: string): Promise<void> {
	const target = await vscode.window.showSaveDialog({
		filters: { JSON: ['json'] },
		defaultUri: vscode.Uri.joinPath(vscode.Uri.file(homedir()), fileName),
		saveLabel: 'Export',
	});
	if (!target) {
		return;
	}

	const exportFile: ServerExportFile = {
		version: 6,
		servers,
	};
	try {
		await vscode.workspace.fs.writeFile(
			target,
			Buffer.from(`${JSON.stringify(exportFile, undefined, 2)}\n`, 'utf8'),
		);
	} catch (error) {
		void vscode.window.showErrorMessage(`Could not export servers: ${errorMessage(error)}`);
		return;
	}

	void vscode.window.showInformationMessage(`Exported ${formatServerCount(servers.length)}.`);
}

export async function importServers(serverStore: ServerStore): Promise<void> {
	const selection = await vscode.window.showOpenDialog({
		canSelectMany: false,
		filters: { JSON: ['json'] },
		openLabel: 'Import',
	});
	if (!selection?.[0]) {
		return;
	}

	let importedServers: ExportedServer[];
	try {
		const contents = await vscode.workspace.fs.readFile(selection[0]);
		importedServers = parseServerExport(JSON.parse(Buffer.from(contents).toString('utf8')));
	} catch (error) {
		void vscode.window.showErrorMessage(`Could not import servers: ${errorMessage(error)}`);
		return;
	}

	await serverStore.importServers(importedServers);
	void vscode.window.showInformationMessage(`Imported ${formatServerCount(importedServers.length)}.`);
}

function formatServerCount(count: number): string {
	return `${count} server${count === 1 ? '' : 's'}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sanitizeFileName(fileName: string): string {
	return fileName.replace(/[\\/:*?"<>|]/g, '-');
}