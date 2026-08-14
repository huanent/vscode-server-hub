import type { ReactNode } from 'react';

export function FieldLabel({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
	return <span className="mb-2 block text-xs font-semibold">{children}{hint && <small className="ml-1 font-normal text-(--vscode-descriptionForeground)">{hint}</small>}</span>;
}