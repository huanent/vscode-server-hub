export function splitMysqlStatements(script: string): string[] {
	const statements: string[] = [];
	let statement = '';
	let delimiter = ';';
	let quote: "'" | '"' | '`' | undefined;
	let lineComment = false;
	let blockComment = false;
	let escaped = false;
	let lineStart = true;
	let hasContent = false;

	for (let index = 0; index < script.length;) {
		if (lineComment) {
			const character = script[index++];
			statement += character;
			if (character === '\n') {
				lineComment = false;
				lineStart = true;
			}
			continue;
		}
		if (blockComment) {
			if (script.startsWith('*/', index)) {
				statement += '*/';
				index += 2;
				blockComment = false;
			} else {
				const character = script[index++];
				statement += character;
				lineStart = character === '\n';
			}
			continue;
		}
		if (quote) {
			const character = script[index++];
			statement += character;
			if (escaped) {
				escaped = false;
			} else if (character === '\\' && quote !== '`') {
				escaped = true;
			} else if (character === quote) {
				if (script[index] === quote) {
					statement += script[index++];
				} else {
					quote = undefined;
				}
			}
			lineStart = character === '\n';
			continue;
		}

		if (lineStart) {
			const lineEnd = script.indexOf('\n', index);
			const end = lineEnd === -1 ? script.length : lineEnd;
			const line = script.slice(index, end);
			const directive = /^\s*DELIMITER\s+(\S+)\s*$/i.exec(line);
			if (directive && !hasContent) {
				delimiter = directive[1];
				index = lineEnd === -1 ? script.length : lineEnd + 1;
				statement = '';
				lineStart = true;
				continue;
			}
		}

		if (script.startsWith(delimiter, index)) {
			if (hasContent) {
				statements.push(statement.trim());
			}
			statement = '';
			hasContent = false;
			index += delimiter.length;
			lineStart = false;
			continue;
		}
		if (script.startsWith('/*', index)) {
			if (script[index + 2] === '!') {
				hasContent = true;
			}
			statement += '/*';
			index += 2;
			blockComment = true;
			continue;
		}
		if (script[index] === '#' || (script.startsWith('--', index) && /\s/.test(script[index + 2] ?? ''))) {
			statement += script[index];
			index++;
			lineComment = true;
			continue;
		}

		const character = script[index++];
		statement += character;
		if (character === "'" || character === '"' || character === '`') {
			quote = character;
			hasContent = true;
		} else if (!/\s/.test(character)) {
			hasContent = true;
		}
		lineStart = character === '\n';
	}

	if (hasContent) {
		statements.push(statement.trim());
	}
	return statements;
}