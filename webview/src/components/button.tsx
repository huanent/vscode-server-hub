import type { ButtonHTMLAttributes } from 'react';

export function IconButton({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
	return <button className={`grid size-8.5 shrink-0 place-items-center border border-(--vscode-widget-border,var(--vscode-panel-border)) bg-transparent text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground) disabled:cursor-default disabled:opacity-55 ${className}`} {...props} />;
}

export function PrimaryButton({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
	return <button className={`inline-flex h-8.5 items-center justify-center gap-2 border border-(--vscode-button-border,transparent) bg-(--vscode-button-background) px-3 text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground) disabled:cursor-default disabled:opacity-55 ${className}`} {...props} />;
}