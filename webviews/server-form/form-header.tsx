import { PrimaryButton } from '../components/form-controls';

interface FormHeaderProps {
	title: string;
	description: string;
	formValid: boolean;
	submitting: boolean;
}

export function FormHeader({ title, description, formValid, submitting }: FormHeaderProps) {
	return <header className="sticky top-0 z-10 border-b border-panel-border bg-editor-background px-6 py-3 max-sm:px-4">
		<div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
			<div className="flex min-w-0 items-center gap-3">
				<span className="codicon codicon-server grid size-9 shrink-0 place-items-center rounded-sm border border-panel-border bg-editor-widget-background text-base" aria-hidden="true" />
				<div className="min-w-0">
					<h1 className="truncate text-base font-semibold">{title}</h1>
					<p className="truncate text-xs leading-5 text-description-foreground">{description}</p>
				</div>
			</div>
			<PrimaryButton className="shrink-0" type="submit" disabled={!formValid || submitting}>
				<span className={`codicon ${submitting ? 'codicon-loading codicon-modifier-spin' : 'codicon-check'}`} aria-hidden="true" />
				{submitting ? 'Saving' : 'Save'}
			</PrimaryButton>
		</div>
	</header>;
}