import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

export const inputClassName = 'w-full border border-(--vscode-input-border,var(--vscode-widget-border)) bg-(--vscode-input-background) text-(--vscode-input-foreground) outline-none focus:border-(--vscode-focusBorder)';

export function IconButton({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
	return <button className={`grid size-8.5 shrink-0 place-items-center border border-(--vscode-widget-border) bg-transparent text-(--vscode-icon-foreground) hover:bg-(--vscode-toolbar-hoverBackground) disabled:cursor-default disabled:opacity-55 ${className}`} {...props} />;
}

export function PrimaryButton({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
	return <button className={`inline-flex h-8.5 items-center justify-center gap-2 border border-(--vscode-button-border,transparent) bg-(--vscode-button-background) px-3 text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground) disabled:cursor-default disabled:opacity-55 ${className}`} {...props} />;
}

export function FieldLabel({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
	return <span className="mb-2 block text-xs font-semibold">{children}{hint && <small className="ml-1 font-normal text-(--vscode-descriptionForeground)">{hint}</small>}</span>;
}

export function TextInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
	return <input className={`${inputClassName} h-8.5 px-2.5 ${className}`} {...props} />;
}

export function SelectInput({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
	return <select className={`${inputClassName} h-8.5 px-2.5 ${className}`} {...props} />;
}

export function TextArea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
	return <textarea className={`${inputClassName} min-h-32 resize-y px-2.5 py-2 font-(--vscode-editor-font-family) text-xs leading-6 ${className}`} {...props} />;
}

export function PageHeading({ icon, title, description, accentClassName }: { icon: ReactNode; title: string; description: string; accentClassName: string }) {
	return (
		<header className="mb-6 flex min-w-0 items-center gap-3.5">
			<div className={`grid size-11 shrink-0 place-items-center border border-(--vscode-widget-border) ${accentClassName}`}>{icon}</div>
			<div className="min-w-0">
				<h1 className="m-0 text-2xl font-semibold">{title}</h1>
				<p className="mt-1 mb-0 text-[13px] text-(--vscode-descriptionForeground)">{description}</p>
			</div>
		</header>
	);
}