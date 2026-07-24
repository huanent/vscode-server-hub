import type { ButtonHTMLAttributes } from 'react';

export function FileButton({ label, onClick }: { label: string; onClick(): void }) {
	return <button className="inline-flex min-h-6 min-w-0 items-center gap-1.5 rounded-sm border border-transparent bg-transparent px-2 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-toolbar-hover-background focus-visible:outline focus-visible:outline-offset-2 focus-visible:outline-focus-border" type="button" onClick={onClick}>
		<span className="codicon codicon-folder-opened" aria-hidden="true" />{label}
	</button>;
}

export function PrimaryButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
	return <button {...props} className={`inline-flex min-h-9 min-w-20 cursor-pointer items-center justify-center gap-1.5 rounded-sm border border-transparent bg-button-background px-3.5 py-2 font-vscode font-semibold text-button-foreground transition-colors hover:bg-button-hover-background focus-visible:outline focus-visible:outline-offset-2 focus-visible:outline-focus-border disabled:cursor-default disabled:bg-button-secondary-background disabled:text-disabled-foreground disabled:opacity-65 ${props.className ?? ''}`} />;
}
