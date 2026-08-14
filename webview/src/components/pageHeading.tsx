import type { ReactNode } from 'react';

export function PageHeading({ icon, title, description, accentClassName }: { icon: ReactNode; title: string; description: string; accentClassName: string }) {
	return (
		<header className="mb-6 flex min-w-0 items-center gap-3.5">
			<div className={`grid size-11 shrink-0 place-items-center border border-(--vscode-widget-border,var(--vscode-panel-border)) ${accentClassName}`}>{icon}</div>
			<div className="min-w-0">
				<h1 className="m-0 text-2xl font-semibold">{title}</h1>
				<p className="mt-1 mb-0 text-[13px] text-(--vscode-descriptionForeground)">{description}</p>
			</div>
		</header>
	);
}