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
	return <div className="grid h-screen min-w-80 grid-rows-[minmax(0,1fr)_26px] overflow-hidden"><main className="min-h-0 overflow-auto">{result.kind === 'command' ? <div className="grid min-h-full place-items-center p-6 text-center text-(--vscode-descriptionForeground)">{result.message}</div> : <table className="w-max min-w-full border-separate border-spacing-0 font-(family-name:--vscode-editor-font-family) text-xs"><thead><tr>{result.columns.map(column => <th key={column} className="sticky top-0 z-10 max-w-120 overflow-hidden border-r border-b border-(--vscode-panel-border,var(--vscode-widget-border)) bg-(--vscode-editor-background) px-2.5 py-1.5 text-left font-semibold text-ellipsis whitespace-pre" title={column}>{column}</th>)}</tr></thead><tbody>{result.rows.map((row, rowIndex) => <tr key={rowIndex} className="hover:bg-(--vscode-list-hoverBackground)">{row.map((value, columnIndex) => <td key={columnIndex} className={`max-w-120 overflow-hidden border-r border-b border-(--vscode-panel-border,var(--vscode-widget-border)) px-2.5 py-1.5 text-left text-ellipsis whitespace-pre ${value === null ? 'italic text-(--vscode-descriptionForeground)' : ''}`} title={value ?? 'NULL'}>{value ?? 'NULL'}</td>)}</tr>)}</tbody></table>}</main><footer className="flex min-w-0 items-center gap-4 border-t border-(--vscode-panel-border,var(--vscode-widget-border)) px-3 text-xs"><span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-(--vscode-descriptionForeground)" title={`Database ${result.serverName} / ${result.database}`}>Database {result.serverName} / {result.database}</span><span className="ml-auto shrink-0 whitespace-nowrap">{result.summary}</span></footer></div>;
}