import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

export function Codicon({ name, size = 16, className = '', style, ...props }: { name: string; size?: number; className?: string } & HTMLAttributes<HTMLSpanElement>) {
	return <span aria-hidden="true" className={`codicon codicon-${name} ${className}`} style={{ fontSize: size, ...style }} {...props} />;
}

export const inputClassName = 'w-full border border-input-border bg-input text-input-foreground outline-none focus:border-focus';

export function IconButton({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
	return <button className={`grid size-8.5 shrink-0 place-items-center border border-widget-border bg-transparent text-icon hover:bg-toolbar-hover disabled:cursor-default disabled:opacity-55 ${className}`} {...props} />;
}

export function PrimaryButton({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
	return <button className={`inline-flex h-8.5 items-center justify-center gap-2 border border-button-border bg-button px-3 text-button-foreground hover:bg-button-hover disabled:cursor-default disabled:opacity-55 ${className}`} {...props} />;
}

export function FieldLabel({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
	return <span className="mb-2 block text-xs font-semibold">{children}{hint && <small className="ml-1 font-normal text-muted">{hint}</small>}</span>;
}

export function TextInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
	return <input className={`${inputClassName} h-8.5 px-2.5 ${className}`} {...props} />;
}

export function SelectInput({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
	return <select className={`${inputClassName} h-8.5 px-2.5 ${className}`} {...props} />;
}

export function TextArea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
	return <textarea className={`${inputClassName} min-h-32 resize-y px-2.5 py-2 font-mono text-xs leading-6 ${className}`} {...props} />;
}

export function PageHeading({ icon, title, description, accentClassName }: { icon: ReactNode; title: string; description: string; accentClassName: string }) {
	return (
		<header className="mb-6 flex min-w-0 items-center gap-3.5">
			<div className={`grid size-11 shrink-0 place-items-center border border-widget-border ${accentClassName}`}>{icon}</div>
			<div className="min-w-0">
				<h1 className="m-0 text-2xl font-semibold">{title}</h1>
				<p className="mt-1 mb-0 text-[13px] text-muted">{description}</p>
			</div>
		</header>
	);
}