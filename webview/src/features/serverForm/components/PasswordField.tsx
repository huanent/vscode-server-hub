import { useState } from 'react';
import { Codicon, FieldLabel, IconButton, TextInput } from '../../../components/ui';

export function PasswordField({ label, value, required, placeholder, onChange }: {
	label: string;
	value: string;
	required?: boolean;
	placeholder?: string;
	onChange: (value: string) => void;
}) {
	const [visible, setVisible] = useState(false);
	return (
		<label className="block min-w-0">
			<FieldLabel>{label}{required && <span className="ml-1 text-error">*</span>}</FieldLabel>
			<span className="flex">
				<TextInput className="min-w-0 border-r-0" type={visible ? 'text' : 'password'} value={value} required={required} placeholder={placeholder} onChange={event => onChange(event.target.value)} />
				<IconButton type="button" title={visible ? 'Hide value' : 'Show value'} aria-label={visible ? 'Hide value' : 'Show value'} onClick={() => setVisible(current => !current)}>
					<Codicon name={visible ? 'eye-closed' : 'eye'} />
				</IconButton>
			</span>
		</label>
	);
}