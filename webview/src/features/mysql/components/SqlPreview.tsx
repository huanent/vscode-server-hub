export function SqlPreview({ sql }: { sql: string }) {
	return <pre className="m-0 max-h-[55vh] overflow-auto bg-(--vscode-textCodeBlock-background) p-3 font-(--vscode-editor-font-family) text-xs leading-6 whitespace-pre-wrap wrap-break-word">{sql}</pre>;
}