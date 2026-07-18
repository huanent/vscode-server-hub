import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { ExportedServer, parseServerExport, ServerExportFile } from './server';
import { ServerStore } from './serverStore';
import { ServerTreeDataProvider } from './serverTree';

export async function exportServers(serverStore: ServerStore): Promise<void> {
	const servers = serverStore.getServers();
	if (servers.length === 0) {
		void vscode.window.showInformationMessage('There are no servers to export.');
		return;
	}

	const confirmation = await vscode.window.showWarningMessage(
		'The exported JSON file will contain passwords in plain text.',
		{ modal: true },
		'Export',
	);
	if (confirmation !== 'Export') {
		return;
	}

	const target = await vscode.window.showSaveDialog({
		filters: { JSON: ['json'] },
		defaultUri: vscode.Uri.joinPath(vscode.Uri.file(homedir()), 'server-hub-export.json'),
		saveLabel: 'Export',
	});
	if (!target) {
		return;
	}

	const exportFile: ServerExportFile = {
		version: 2,
		servers: await serverStore.getExportedServers(),
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

export async function importServers(
	serverStore: ServerStore,
	treeDataProvider: ServerTreeDataProvider,
): Promise<void> {
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

	const confirmation = await vscode.window.showWarningMessage(
		`Import ${formatServerCount(importedServers.length)} and store the included passwords? Existing servers with the same ID will be updated.`,
		{ modal: true },
		'Import',
	);
	if (confirmation !== 'Import') {
		return;
	}

	await serverStore.importServers(importedServers);
	treeDataProvider.refresh();
	void vscode.window.showInformationMessage(`Imported ${formatServerCount(importedServers.length)}.`);
}

function formatServerCount(count: number): string {
	return `${count} server${count === 1 ? '' : 's'}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}