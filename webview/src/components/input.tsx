import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

export const inputClassName = 'w-full rounded-[2px] border border-[var(--vscode-input-border,var(--vscode-widget-border,var(--vscode-panel-border)))] bg-(--vscode-input-background) text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder) disabled:bg-(--vscode-input-background) disabled:text-(--vscode-disabledForeground,var(--vscode-descriptionForeground)) disabled:opacity-70';

export function TextInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
	return <input className={`${inputClassName} h-8.5 px-2.5 ${className}`} {...props} />;
}

export function SelectInput({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
	return <select className={`${inputClassName} h-8.5 px-2.5 text-(--vscode-dropdown-foreground) ${className}`} {...props} />;
}

export function TextArea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
	return <textarea className={`${inputClassName} min-h-32 resize-y px-2.5 py-2 font-(family-name:--vscode-editor-font-family) text-xs leading-6 ${className}`} {...props} />;
}