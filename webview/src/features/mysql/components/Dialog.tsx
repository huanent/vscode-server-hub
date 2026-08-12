import type { ReactNode } from 'react';
import { IconButton } from '../../../components/button';
import { Codicon } from '../../../components/codicon';

export function Dialog({ title, children, actions, onClose, wide = false }: { title: string; children: ReactNode; actions?: ReactNode; onClose: () => void; wide?: boolean }) {
	return <div className="fixed inset-0 z-30 grid place-items-center bg-black/45 p-5" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
		<section className={`grid max-h-full min-h-0 w-full grid-rows-[42px_minmax(0,1fr)_auto] overflow-hidden border border-border bg-app shadow-widget ${wide ? 'max-w-245' : 'max-w-180'}`} role="dialog" aria-modal="true">
			<header className="flex min-w-0 items-center border-b border-border px-3"><h2 className="m-0 min-w-0 text-sm font-semibold">{title}</h2><IconButton className="ml-auto border-0" type="button" title="Close" aria-label="Close" onClick={onClose}><Codicon name="close" /></IconButton></header>
			<div className="min-h-0 overflow-auto p-4">{children}</div>
			{actions && <footer className="flex justify-end gap-2 border-t border-border p-3">{actions}</footer>}
		</section>
	</div>;
}