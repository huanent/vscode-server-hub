import * as vscode from 'vscode';

export function createNonce(): string {
	return crypto.randomUUID().replaceAll('-', '');
}

export function codiconsDistUri(extensionUri: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(extensionUri, 'resources', 'codicons');
}

export function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#039;');
}