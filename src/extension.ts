import * as vscode from 'vscode';
import { activateServerHubFeature } from './features/serverHub/serverHubFeature';
import { initializeSftpFileEditing } from './ssh/sshTerminal';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	await initializeSftpFileEditing(context);
	await activateServerHubFeature(context);
}

export function deactivate(): void {}
