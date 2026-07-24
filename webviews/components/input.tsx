import { useId, useRef, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';

export const controlClassName = 'w-full min-h-9 rounded-sm border border-input-border bg-input-background px-2.5 py-2 font-vscode text-input-foreground outline-none transition-colors hover:border-dropdown-border focus:border-focus-border focus:shadow-focus-border';

export function TextInput({ options, list, className, onBlur, onChange, onFocus, onKeyDown, ...props }: InputHTMLAttributes<HTMLInputElement> & { options?: readonly string[] }) {
	const listId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const [isOpen, setIsOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(-1);
	const hasOptions = Boolean(options?.length);
	const selectOption = (input: HTMLInputElement, option: string) => {
		const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
		valueSetter?.call(input, option);
		input.dispatchEvent(new Event('input', { bubbles: true }));
		setIsOpen(false);
	};

	return <div className={hasOptions ? 'relative' : undefined}>
		<input
			{...props}
			ref={inputRef}
			list={hasOptions ? undefined : list}
			className={`${controlClassName} ${hasOptions ? 'pr-9' : ''} ${className ?? ''}`}
			role={hasOptions ? 'combobox' : props.role}
			aria-autocomplete={hasOptions ? 'list' : undefined}
			aria-controls={hasOptions ? listId : undefined}
			aria-expanded={hasOptions ? isOpen : undefined}
			aria-activedescendant={isOpen && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined}
			onBlur={event => {
				onBlur?.(event);
				setIsOpen(false);
			}}
			onChange={event => {
				onChange?.(event);
				if (hasOptions) {
					setIsOpen(true);
					setActiveIndex(options!.indexOf(event.currentTarget.value));
				}
			}}
			onFocus={event => {
				onFocus?.(event);
				if (hasOptions) setActiveIndex(options!.indexOf(event.currentTarget.value));
			}}
			onKeyDown={event => {
				onKeyDown?.(event);
				if (event.defaultPrevented || !options?.length) return;

				if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
					event.preventDefault();
					setIsOpen(true);
					setActiveIndex(currentIndex => event.key === 'ArrowDown'
						? (currentIndex + 1) % options.length
						: (currentIndex <= 0 ? options.length : currentIndex) - 1);
				} else if (event.key === 'Enter' && isOpen && activeIndex >= 0) {
					event.preventDefault();
					selectOption(event.currentTarget, options[activeIndex]);
				} else if (event.key === 'Escape' && isOpen) {
					event.preventDefault();
					setIsOpen(false);
				}
			}}
		/>
		{hasOptions ? <button
			className={`codicon ${isOpen ? 'codicon-chevron-up' : 'codicon-chevron-down'} absolute right-0 top-0 grid size-9 min-h-9 min-w-9 place-items-center border-0 bg-transparent p-0 text-input-foreground opacity-80 hover:bg-toolbar-hover-background hover:text-foreground hover:opacity-100 focus-visible:outline focus-visible:outline-offset-2 focus-visible:outline-focus-border`}
			type="button"
			title={isOpen ? 'Hide options' : 'Show options'}
			aria-label={isOpen ? 'Hide options' : 'Show options'}
			aria-controls={listId}
			aria-expanded={isOpen}
			onMouseDown={event => event.preventDefault()}
			onClick={() => {
				inputRef.current?.focus();
				setActiveIndex(options!.indexOf(inputRef.current?.value ?? ''));
				setIsOpen(open => !open);
			}}
		/> : null}
		{hasOptions && isOpen ? <div className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-sm border border-dropdown-border bg-editor-widget-background py-1 shadow-lg" id={listId} role="listbox">
			{options!.map((option, index) => <div
				key={option}
				className={`cursor-default px-2.5 py-1.5 text-xs text-foreground ${index === activeIndex ? 'bg-button-background text-button-foreground' : 'hover:bg-toolbar-hover-background'}`}
				id={`${listId}-option-${index}`}
				role="option"
				aria-selected={index === activeIndex}
				onMouseDown={event => {
					event.preventDefault();
					if (inputRef.current) selectOption(inputRef.current, option);
				}}
				onMouseEnter={() => setActiveIndex(index)}
			>{option}</div>)}
		</div> : null}
	</div>;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
	return <textarea {...props} className={`${controlClassName} min-h-36 resize-y font-editor ${props.className ?? ''}`} />;
}

export function SecretInput({ value, visible, autoComplete, onChange, toggle }: { value: string; visible?: boolean; autoComplete: string; onChange(value: string): void; toggle(): void }) {
	const label = visible ? 'Hide value' : 'Show value';
	return <span className="relative">
		<TextInput className="pr-9" type={visible ? 'text' : 'password'} autoComplete={autoComplete} value={value} onChange={event => onChange(event.target.value)} />
		<button className={`codicon ${visible ? 'codicon-eye-closed' : 'codicon-eye'} absolute right-0 top-0 grid size-9 min-h-9 min-w-9 place-items-center border-0 bg-transparent p-0 text-input-foreground opacity-80 hover:bg-toolbar-hover-background hover:text-foreground hover:opacity-100 focus-visible:outline focus-visible:outline-offset-2 focus-visible:outline-focus-border`} type="button" title={label} aria-label={label} onClick={toggle} />
	</span>;
}
