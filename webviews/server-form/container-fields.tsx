import { FileButton } from '../components/button';
import { Field, SegmentedControl } from '../components/form-controls';
import { TextInput } from '../components/input';
import type { FormFieldsProps, Runtime } from './types';

const runtimeDefaults: Record<Runtime, string> = {
	docker: 'docker',
	podman: 'podman',
	apple: '/opt/homebrew/bin/container',
};

interface ContainerFieldsProps extends FormFieldsProps {
	onSelectExecutable(): void;
}

export function ContainerFields({ values, setValue, onSelectExecutable }: ContainerFieldsProps) {
	const selectRuntime = (runtime: Runtime) => {
		const currentDefault = runtimeDefaults[values.runtime as Runtime];
		setValue('runtime', runtime);
		if (!values.executablePath || values.executablePath === currentDefault) {
			setValue('executablePath', runtimeDefaults[runtime]);
		}
	};
	return <>
		<SegmentedControl label="Container runtime" value={values.runtime} options={[["docker", "Docker"], ["podman", "Podman"], ["apple", "Apple"]]} onChange={value => selectRuntime(value as Runtime)} />
		<Field label="Executable" required action={<FileButton label="Select file" onClick={onSelectExecutable} />}>
			<TextInput autoComplete="off" required placeholder="docker" value={values.executablePath} onChange={event => setValue('executablePath', event.target.value)} />
		</Field>
	</>;
}