import type { ButtonHTMLAttributes } from 'react';

export function IconButton({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
	return <button className={`grid size-8.5 shrink-0 place-items-center border border-widget-border bg-transparent text-icon hover:bg-toolbar-hover disabled:cursor-default disabled:opacity-55 ${className}`} {...props} />;
}

export function PrimaryButton({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
	return <button className={`inline-flex h-8.5 items-center justify-center gap-2 border border-button-border bg-button px-3 text-button-foreground hover:bg-button-hover disabled:cursor-default disabled:opacity-55 ${className}`} {...props} />;
}