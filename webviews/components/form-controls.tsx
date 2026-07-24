import type { ReactNode } from 'react';

export function Field({ label, required, action, className = '', children }: { label: string; required?: boolean; action?: ReactNode; className?: string; children: ReactNode }) {
	return <label className={`grid min-w-0 gap-1.5 ${className}`}>
		<span className="flex items-center justify-between gap-2">
			<span className="text-xs font-medium text-description-foreground">{label}{required && <span className="text-error-foreground" aria-hidden="true"> *</span>}</span>
			{action}
		</span>
		{children}
	</label>;
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

