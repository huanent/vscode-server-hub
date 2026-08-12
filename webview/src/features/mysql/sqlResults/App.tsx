import { useEffect, useState } from 'react';
import { vscode } from '../../../vscodeApi';

type SqlResult =
	| { serverName: string; database: string; summary: string; kind: 'rows'; columns: string[]; rows: Array<Array<string | null>> }
	| { serverName: string; database: string; summary: string; kind: 'command'; message: string };

export function App() {
	const [result, setResult] = useState<SqlResult>();
	useEffect(() => {
		const listener = (event: MessageEvent<{ type: 'result'; result: SqlResult }>) => { if (event.data.type === 'result') setResult(event.data.result); };
		window.addEventListener('message', listener);
		vscode.postMessage({ type: 'ready' });
		return () => window.removeEventListener('message', listener);
	}, []);
	if (!result) return <div className="grid min-h-screen place-items-center text-(--vscode-descriptionForeground)">Run a SQL statement to view results.</div>;
	return <div className="min-h-screen min-w-80 overflow-auto"><header className="sticky top-0 z-20 flex min-h-9 items-center justify-between gap-4 border-b border-(--vscode-panel-border) bg-(--vscode-editor-background) px-3 py-2 text-xs"><span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-(--vscode-descriptionForeground)" title={`${result.serverName} / ${result.database}`}>{result.serverName} / {result.database}</span><span className="shrink-0">{result.summary}</span></header>{result.kind === 'command' ? <div className="grid min-h-45 place-items-center p-6 text-center text-(--vscode-descriptionForeground)">{result.message}</div> : <table className="w-max min-w-full border-separate border-spacing-0 font-(--vscode-editor-font-family) text-xs"><thead><tr>{result.columns.map(column => <th key={column} className="sticky top-9 z-10 max-w-120 overflow-hidden border-r border-b border-(--vscode-panel-border) bg-(--vscode-editorGroupHeader-tabsBackground,var(--vscode-editor-background)) px-2.5 py-1.5 text-left font-semibold text-ellipsis whitespace-pre" title={column}>{column}</th>)}</tr></thead><tbody>{result.rows.map((row, rowIndex) => <tr key={rowIndex} className="hover:bg-(--vscode-list-hoverBackground)">{row.map((value, columnIndex) => <td key={columnIndex} className={`max-w-120 overflow-hidden border-r border-b border-(--vscode-panel-border) px-2.5 py-1.5 text-left text-ellipsis whitespace-pre ${value === null ? 'italic text-(--vscode-descriptionForeground)' : ''}`} title={value ?? 'NULL'}>{value ?? 'NULL'}</td>)}</tr>)}</tbody></table>}</div>;
}