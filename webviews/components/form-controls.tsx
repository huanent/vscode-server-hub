import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';

const controlClassName = 'w-full min-h-9 rounded-sm border border-input-border bg-input-background px-2.5 py-2 font-vscode text-input-foreground outline-none transition-colors hover:border-dropdown-border focus:border-focus-border focus:shadow-focus-border';

export function Field({ label, required, action, className = '', children }: { label: string; required?: boolean; action?: ReactNode; className?: string; children: ReactNode }) {
	return <label className={`grid min-w-0 gap-1.5 ${className}`}>
		<span className="flex items-center justify-between gap-2">
			<span className="text-xs font-medium text-description-foreground">{label}{required && <span className="text-error-foreground" aria-hidden="true"> *</span>}</span>
			{action}
		</span>
		{children}
	</label>;
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
	return <input {...props} className={`${controlClassName} ${props.className ?? ''}`} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
	return <textarea {...props} className={`${controlClassName} min-h-36 resize-y font-editor ${props.className ?? ''}`} />;
}

export function SegmentedControl({ label, value, options, onChange }: { label: string; value: string; options: ReadonlyArray<readonly [string, string]>; onChange(value: string): void }) {
	return <div className="grid min-w-0 gap-1.5">
		<span className="text-xs font-medium text-description-foreground">{label}</span>
		<div className="inline-flex min-h-9 justify-self-start gap-px rounded-sm border border-panel-border bg-editor-widget-background p-0.5" role="tablist" aria-label={label}>
			{options.map(([option, text]) => <button
				key={option}
				className="min-h-8 min-w-0 rounded-sm border border-transparent bg-transparent px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-toolbar-hover-background focus-visible:outline focus-visible:outline-offset-2 focus-visible:outline-focus-border aria-selected:bg-button-background aria-selected:text-button-foreground"
				type="button"
				role="tab"
				aria-selected={value === option}
				tabIndex={value === option ? 0 : -1}
				onClick={() => onChange(option)}
			>{text}</button>)}
		</div>
	</div>;
}

export function FileButton({ label, onClick }: { label: string; onClick(): void }) {
	return <button className="inline-flex min-h-6 min-w-0 items-center gap-1.5 rounded-sm border border-transparent bg-transparent px-2 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-toolbar-hover-background focus-visible:outline focus-visible:outline-offset-2 focus-visible:outline-focus-border" type="button" onClick={onClick}>
		<span className="codicon codicon-folder-opened" aria-hidden="true" />{label}
	</button>;
}

export function SecretInput({ value, visible, autoComplete, onChange, toggle }: { value: string; visible?: boolean; autoComplete: string; onChange(value: string): void; toggle(): void }) {
	const label = visible ? 'Hide value' : 'Show value';
	return <span className="relative">
		<TextInput className="pr-9" type={visible ? 'text' : 'password'} autoComplete={autoComplete} value={value} onChange={event => onChange(event.target.value)} />
		<button className={`codicon ${visible ? 'codicon-eye-closed' : 'codicon-eye'} absolute right-0 top-0 grid size-9 min-h-9 min-w-9 place-items-center border-0 bg-transparent p-0 text-input-foreground opacity-80 hover:bg-toolbar-hover-background hover:text-foreground hover:opacity-100 focus-visible:outline focus-visible:outline-offset-2 focus-visible:outline-focus-border`} type="button" title={label} aria-label={label} onClick={toggle} />
	</span>;
}

export function PrimaryButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
	return <button {...props} className={`inline-flex min-h-9 min-w-20 cursor-pointer items-center justify-center gap-1.5 rounded-sm border border-transparent bg-button-background px-3.5 py-2 font-vscode font-semibold text-button-foreground transition-colors hover:bg-button-hover-background focus-visible:outline focus-visible:outline-offset-2 focus-visible:outline-focus-border disabled:cursor-default disabled:bg-button-secondary-background disabled:text-disabled-foreground disabled:opacity-65 ${props.className ?? ''}`} />;
}