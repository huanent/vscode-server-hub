import * as vscode from 'vscode';
import { createNonce } from './utils';

export function getWebviewHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	entry: string,
	title: string,
): string {
	const nonce = createNonce();
	const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'styles.css'));
	const entryStyleUri = entry === 'sshTerminal'
		? webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'sshTerminal.css'))
		: undefined;
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', `${entry}.js`));

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';">
	<link rel="stylesheet" href="${styleUri}">
	${entryStyleUri ? `<link rel="stylesheet" href="${entryStyleUri}">` : ''}
	<title>${title}</title>
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}