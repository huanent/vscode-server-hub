import { Field, TextInput } from '../components/form-controls';
import type { FormFieldsProps, ServerType } from './types';

interface BasicInformationProps extends FormFieldsProps {
	serverType: ServerType;
	groups: string[];
}

export function BasicInformation({ serverType, groups, values, setValue }: BasicInformationProps) {
	const serverTypeLabel = serverType === 'mysql' ? 'MySQL' : serverType === 'container' ? 'Container' : 'SSH';
	return <section className="pb-7" aria-labelledby="identity-heading">
		<div className="mb-4 flex items-center justify-between gap-3">
			<h2 className="text-sm font-semibold" id="identity-heading">Basic information</h2>
			<span className="rounded-sm border border-panel-border bg-editor-widget-background px-2 py-0.5 text-xs text-description-foreground">{serverTypeLabel}</span>
		</div>
		<div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
			<Field label="Name" required>
				<TextInput autoFocus autoComplete="off" required placeholder="Production" value={values.name} onChange={event => setValue('name', event.target.value)} />
			</Field>
			<Field label="Group">
				<TextInput autoComplete="off" list="server-groups" placeholder="No group" value={values.group} onChange={event => setValue('group', event.target.value)} />
				<datalist id="server-groups">{groups.map(group => <option key={group} value={group} />)}</datalist>
			</Field>
		</div>
	</section>;
}