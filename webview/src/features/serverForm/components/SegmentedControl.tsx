interface Option<Value extends string> {
	value: Value;
	label: string;
}

export function SegmentedControl<Value extends string>({ label, options, value, onChange }: {
	label: string;
	options: Option<Value>[];
	value: Value;
	onChange: (value: Value) => void;
}) {
	return (
		<div className="inline-grid min-h-8.5 grid-flow-col overflow-hidden rounded-[2px] border border-(--vscode-widget-border,var(--vscode-panel-border)) bg-(--vscode-input-background)" role="group" aria-label={label}>
			{options.map(option => (
				<button
					key={option.value}
					type="button"
					className={`border-0 border-r border-(--vscode-widget-border,var(--vscode-panel-border)) bg-transparent px-3 text-(--vscode-foreground) last:border-r-0 hover:bg-(--vscode-toolbar-hoverBackground) ${value === option.value ? 'bg-(--vscode-button-background)! font-semibold text-(--vscode-button-foreground)!' : ''}`}
					aria-pressed={value === option.value}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}