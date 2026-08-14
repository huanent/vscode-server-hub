import type { ButtonHTMLAttributes } from 'react';

export function IconButton({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
	return <button className={`grid size-8.5 shrink-0 place-items-center rounded-[2px] border border-(--vscode-widget-border,var(--vscode-panel-border)) bg-transparent text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground) active:bg-(--vscode-toolbar-activeBackground,var(--vscode-toolbar-hoverBackground)) disabled:cursor-default disabled:opacity-50 ${className}`} {...props} />;
}

export function PrimaryButton({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
	return <button className={`inline-flex h-8.5 items-center justify-center gap-2 rounded-[2px] border border-(--vscode-button-border,transparent) bg-(--vscode-button-background) px-3 font-semibold text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground) disabled:cursor-default disabled:opacity-50 ${className}`} {...props} />;
}

export function SecondaryButton({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
	return <button className={`inline-flex h-8.5 items-center justify-center gap-2 rounded-[2px] border border-(--vscode-button-secondaryBackground) bg-(--vscode-button-secondaryBackground) px-3 font-semibold text-(--vscode-button-secondaryForeground) hover:bg-(--vscode-button-secondaryHoverBackground) disabled:cursor-default disabled:opacity-50 ${className}`} {...props} />;
}