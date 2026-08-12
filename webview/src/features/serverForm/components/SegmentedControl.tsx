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
		<div className="inline-grid min-h-8.5 grid-flow-col border border-widget-border" role="group" aria-label={label}>
			{options.map(option => (
				<button
					key={option.value}
					type="button"
					className={`border-0 border-r border-widget-border bg-transparent px-3 text-foreground last:border-r-0 hover:bg-toolbar-hover ${value === option.value ? 'bg-button! text-button-foreground!' : ''}`}
					aria-pressed={value === option.value}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}