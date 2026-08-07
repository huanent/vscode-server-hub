import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useImperativeHandle, useRef } from 'react';

export interface TerminalViewHandle { writeBase64(data: string): void; fit(): void }

export function TerminalView({ ref, onData, onResize, onReady }: { ref: React.Ref<TerminalViewHandle>; onData: (data: string) => void; onResize: (rows: number, columns: number) => void; onReady: () => void }) {
	const elementRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	useImperativeHandle(ref, () => ({
		writeBase64(data) { terminalRef.current?.write(Uint8Array.from(atob(data), character => character.charCodeAt(0))); },
		fit() { const element = elementRef.current; if (element && element.clientWidth > 0 && element.clientHeight > 0) fitRef.current?.fit(); },
	}), []);
	useEffect(() => {
		const style = getComputedStyle(document.documentElement);
		const terminal = new Terminal({ cursorBlink: true, fontFamily: style.getPropertyValue('--vscode-editor-font-family'), fontSize: Number(style.getPropertyValue('--vscode-editor-font-size').replace('px', '')) || 14, scrollback: 5000, theme: { background: style.getPropertyValue('--vscode-editor-background').trim(), foreground: style.getPropertyValue('--vscode-terminal-foreground').trim() || style.getPropertyValue('--vscode-editor-foreground').trim(), cursor: style.getPropertyValue('--vscode-terminalCursor-foreground').trim(), selectionBackground: style.getPropertyValue('--vscode-terminal-selectionBackground').trim() } });
		const fit = new FitAddon();
		terminal.loadAddon(fit);
		terminal.open(elementRef.current!);
		terminalRef.current = terminal;
		fitRef.current = fit;
		const dataDisposable = terminal.onData(onData);
		const resizeDisposable = terminal.onResize(size => onResize(size.rows, size.cols));
		const observer = new ResizeObserver(() => { if (elementRef.current?.clientWidth && elementRef.current.clientHeight) fit.fit(); });
		observer.observe(elementRef.current!);
		requestAnimationFrame(() => { fit.fit(); terminal.focus(); onReady(); });
		return () => { observer.disconnect(); dataDisposable.dispose(); resizeDisposable.dispose(); terminal.dispose(); };
	}, []);
	return <div ref={elementRef} className="h-full w-full" aria-label="SSH terminal" />;
}