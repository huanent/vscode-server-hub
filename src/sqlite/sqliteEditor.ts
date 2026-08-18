import * as vscode from 'vscode';
import { DatabaseSync } from 'node:sqlite';
import { getWebviewHtml } from '../webview';
import { SqliteColumnDefinition, SqliteEditorMessage, SqliteTableDefinition } from './types';
import { SqliteSqlEditorController } from './sqliteSqlEditor';
import { openSqliteTablePreview } from './sqliteTablePreview';
import { errorMessage, quoteIdentifier, quoteValue, readColumnMetadata } from './sqliteUtils';

const sqliteEditorViewType = 'server-hub.sqliteEditor';

class SqliteDocument implements vscode.CustomDocument {
	constructor(readonly uri: vscode.Uri) {}
	dispose(): void {}
}

export function registerSqliteEditor(context: vscode.ExtensionContext): vscode.Disposable {
	const sqlEditor = new SqliteSqlEditorController(context);
	const provider: vscode.CustomReadonlyEditorProvider<SqliteDocument> = {
		openCustomDocument: uri => new SqliteDocument(uri),
		resolveCustomEditor: (document, panel) => configureSqliteEditor(context, document.uri, panel, sqlEditor),
	};
	const editor = vscode.window.registerCustomEditorProvider(sqliteEditorViewType, provider, {
		supportsMultipleEditorsPerDocument: false,
		webviewOptions: { retainContextWhenHidden: true },
	});
	return vscode.Disposable.from(editor, sqlEditor);
}

function configureSqliteEditor(context: vscode.ExtensionContext, uri: vscode.Uri, panel: vscode.WebviewPanel, sqlEditor: SqliteSqlEditorController): void {
	if (uri.scheme !== 'file') {
		throw new Error('SQLite databases can currently only be opened from the local file system.');
	}
	const databaseName = uri.path.split('/').pop() ?? uri.fsPath;
	panel.title = databaseName;
	panel.iconPath = new vscode.ThemeIcon('database');
	panel.webview.options = {
		enableScripts: true,
		localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
	};
	panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri, 'sqliteOverview', databaseName);

	const database = new DatabaseSync(uri.fsPath);
	let tables = new Set<string>();
	let pendingStatement: { id: string; sql: string; execute: () => void } | undefined;
	panel.onDidDispose(() => database.close());
	panel.webview.onDidReceiveMessage(async (message: SqliteEditorMessage) => {
		if (message.type === 'ready') {
			await panel.webview.postMessage({
				type: 'initialize',
				server: { name: databaseName, address: uri.fsPath, database: databaseName, dialect: 'sqlite' },
			});
			loadTables();
			return;
		}
		if (message.type === 'refresh') {
			loadTables();
			return;
		}
		if (message.type === 'deleteTable' && typeof message.table === 'string' && tables.has(message.table)) {
			await deleteTable(message.table);
			return;
		}
		if (message.type === 'openTable' && typeof message.table === 'string' && tables.has(message.table)) {
			openSqliteTablePreview(context, uri, message.table);
			return;
		}
		if (message.type === 'openSql') {
			void sqlEditor.open(uri);
			return;
		}
		if (message.type === 'loadTableDefinition' && typeof message.table === 'string' && tables.has(message.table)) {
			loadTableDefinition(message.table);
			return;
		}
		if (message.type === 'previewCreateTable') {
			previewCreateTable(message.definition);
			return;
		}
		if (message.type === 'previewAlterTable' && typeof message.table === 'string' && tables.has(message.table)) {
			previewAlterTable(message.table, message.definition);
			return;
		}
		if (message.type === 'confirmTableStatement' && typeof message.confirmationId === 'string') {
			confirmTableStatement(message.confirmationId);
		}
	});

	function loadTables(): void {
		void panel.webview.postMessage({ type: 'tablesLoading', database: databaseName });
		try {
			const rows = database.prepare(`
				SELECT name
				FROM sqlite_schema
				WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
				ORDER BY name
			`).all() as Array<{ name: string }>;
			tables = new Set(rows.map(row => String(row.name)));
			void panel.webview.postMessage({
				type: 'tables',
				database: databaseName,
				tables: rows.map(row => {
					const name = String(row.name);
					const count = database.prepare(`SELECT COUNT(*) AS total FROM ${quoteIdentifier(name)}`).get() as { total: number | bigint };
					return {
					name,
					engine: 'SQLite',
					rowCount: Number(count.total),
					dataSize: 0,
					indexSize: 0,
					updatedAt: null,
					collation: '',
					};
				}),
			});
		} catch (error) {
			void panel.webview.postMessage({ type: 'tablesError', message: errorMessage(error) });
		}
	}

	async function deleteTable(table: string): Promise<void> {
		const confirmation = await vscode.window.showWarningMessage(
			`Delete table “${table}” and all of its data?`,
			{ modal: true },
			'Delete',
		);
		if (confirmation !== 'Delete') {
			return;
		}
		try {
			database.exec(`DROP TABLE ${quoteIdentifier(table)}`);
			loadTables();
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not delete table: ${errorMessage(error)}`);
		}
	}

	function loadTableDefinition(table: string): void {
		try {
			const columns = readColumnMetadata(database, table).map(column => ({
				name: column.name,
				originalName: column.name,
				type: normalizeColumnType(column.dataType),
				length: '',
				nullable: column.nullable,
				primaryKey: column.primaryKey,
				autoIncrement: column.autoIncrement,
				defaultKind: column.defaultValue === null ? 'none' : String(column.defaultValue).toUpperCase() === 'CURRENT_TIMESTAMP' ? 'currentTimestamp' : 'value',
				defaultValue: column.defaultValue === null ? '' : stripSqlString(String(column.defaultValue)),
			} satisfies SqliteColumnDefinition));
			void panel.webview.postMessage({ type: 'tableDefinition', table, definition: { name: table, columns } });
		} catch (error) {
			void panel.webview.postMessage({ type: 'tableDefinitionError', message: errorMessage(error) });
		}
	}

	function previewCreateTable(value: unknown): void {
		try {
			const definition = parseDefinition(value, tables);
			const sql = buildCreateTableSql(definition);
			pendingStatement = { id: crypto.randomUUID(), sql, execute: () => database.exec(sql) };
			void panel.webview.postMessage({ type: 'tableStatementPreview', confirmationId: pendingStatement.id, sql });
		} catch (error) {
			pendingStatement = undefined;
			void panel.webview.postMessage({ type: 'tableCreateError', message: errorMessage(error) });
		}
	}

	function previewAlterTable(table: string, value: unknown): void {
		try {
			const originalColumns = new Set(readColumnMetadata(database, table).map(column => column.name));
			const definition = parseDefinition(value, tables, table, originalColumns);
			const temporaryTable = `__server_hub_${crypto.randomUUID().replaceAll('-', '')}`;
			const preservedObjects = database.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL").all(table) as Array<{ sql: string }>;
			const mappedColumns = definition.columns.filter(column => column.originalName && originalColumns.has(column.originalName));
			const statements = [
				'PRAGMA foreign_keys = OFF',
				buildCreateTableSql({ ...definition, name: temporaryTable }),
				...(mappedColumns.length ? [`INSERT INTO ${quoteIdentifier(temporaryTable)} (${mappedColumns.map(column => quoteIdentifier(column.name)).join(', ')}) SELECT ${mappedColumns.map(column => quoteIdentifier(column.originalName!)).join(', ')} FROM ${quoteIdentifier(table)}`] : []),
				`DROP TABLE ${quoteIdentifier(table)}`,
				`ALTER TABLE ${quoteIdentifier(temporaryTable)} RENAME TO ${quoteIdentifier(table)}`,
				...preservedObjects.map(object => object.sql),
				...(definition.name === table ? [] : [`ALTER TABLE ${quoteIdentifier(table)} RENAME TO ${quoteIdentifier(definition.name)}`]),
				'PRAGMA foreign_keys = ON',
			];
			const sql = `${statements.join(';\n')};`;
			pendingStatement = {
				id: crypto.randomUUID(),
				sql,
				execute: () => {
					database.exec('PRAGMA foreign_keys = OFF');
					try {
						database.exec('BEGIN IMMEDIATE');
						for (const statement of statements.slice(1, -1)) database.exec(statement);
						database.exec('COMMIT');
					} catch (error) {
						if (database.isTransaction) database.exec('ROLLBACK');
						throw error;
					} finally {
						database.exec('PRAGMA foreign_keys = ON');
					}
				},
			};
			void panel.webview.postMessage({ type: 'tableStatementPreview', confirmationId: pendingStatement.id, sql });
		} catch (error) {
			pendingStatement = undefined;
			void panel.webview.postMessage({ type: 'tableCreateError', message: errorMessage(error) });
		}
	}

	function confirmTableStatement(confirmationId: string): void {
		if (!pendingStatement || pendingStatement.id !== confirmationId) {
			void panel.webview.postMessage({ type: 'tableCreateError', message: 'The SQL preview has expired. Review the form again.' });
			return;
		}
		try {
			pendingStatement.execute();
			pendingStatement = undefined;
			loadTables();
			void panel.webview.postMessage({ type: 'tableStatementExecuted' });
		} catch (error) {
			void panel.webview.postMessage({ type: 'tableCreateError', message: errorMessage(error) });
		}
	}
}

function parseDefinition(value: unknown, existingTables: Set<string>, originalTable?: string, originalColumns = new Set<string>()): SqliteTableDefinition {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid table definition.');
	const input = value as Record<string, unknown>;
	const name = parseIdentifier(input.name, 'Table name');
	if (existingTables.has(name) && name !== originalTable) throw new Error(`A table named “${name}” already exists.`);
	if (!Array.isArray(input.columns) || input.columns.length === 0) throw new Error('Add at least one column.');
	const names = new Set<string>();
	const columns = input.columns.map((value, index) => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Column ${index + 1} is invalid.`);
		const column = value as Record<string, unknown>;
		const columnName = parseIdentifier(column.name, `Column ${index + 1} name`);
		if (names.has(columnName)) throw new Error(`Column name “${columnName}” is duplicated.`);
		names.add(columnName);
		const originalName = typeof column.originalName === 'string' && originalColumns.has(column.originalName) ? column.originalName : undefined;
		return {
			name: columnName,
			originalName,
			type: normalizeColumnType(typeof column.type === 'string' ? column.type : 'TEXT'),
			length: typeof column.length === 'string' ? column.length : '',
			nullable: Boolean(column.nullable),
			primaryKey: Boolean(column.primaryKey),
			autoIncrement: Boolean(column.autoIncrement),
			defaultKind: ['none', 'null', 'currentTimestamp', 'value'].includes(String(column.defaultKind)) ? column.defaultKind as SqliteColumnDefinition['defaultKind'] : 'none',
			defaultValue: typeof column.defaultValue === 'string' ? column.defaultValue : '',
		};
	});
	const autoColumns = columns.filter(column => column.autoIncrement);
	if (autoColumns.length > 1 || autoColumns.some(column => !column.primaryKey || !['INT', 'BIGINT'].includes(column.type))) throw new Error('AUTOINCREMENT requires a single integer primary key column.');
	return { name, columns };
}

function buildCreateTableSql(definition: SqliteTableDefinition): string {
	const primaryKeys = definition.columns.filter(column => column.primaryKey);
	const columns = definition.columns.map(column => {
		const type = column.autoIncrement ? 'INTEGER' : column.type;
		const parts = [quoteIdentifier(column.name), type];
		if (column.autoIncrement) parts.push('PRIMARY KEY AUTOINCREMENT');
		else if (primaryKeys.length === 1 && column.primaryKey) parts.push('PRIMARY KEY');
		if (!column.nullable && !column.primaryKey) parts.push('NOT NULL');
		if (column.defaultKind === 'null') parts.push('DEFAULT NULL');
		if (column.defaultKind === 'currentTimestamp') parts.push('DEFAULT CURRENT_TIMESTAMP');
		if (column.defaultKind === 'value') parts.push(`DEFAULT ${quoteValue(column.defaultValue)}`);
		return parts.join(' ');
	});
	if (primaryKeys.length > 1) columns.push(`PRIMARY KEY (${primaryKeys.map(column => quoteIdentifier(column.name)).join(', ')})`);
	return `CREATE TABLE ${quoteIdentifier(definition.name)} (\n  ${columns.join(',\n  ')}\n)`;
}

function parseIdentifier(value: unknown, label: string): string {
	const identifier = typeof value === 'string' ? value.trim() : '';
	if (!identifier) throw new Error(`${label} is required.`);
	if (identifier.includes('\0')) throw new Error(`${label} contains an invalid character.`);
	return identifier;
}

function normalizeColumnType(value: string): SqliteColumnDefinition['type'] {
	const type = value.trim().toUpperCase().split(/[\s(]/)[0];
	if (/INT/.test(type)) return type === 'BIGINT' ? 'BIGINT' : 'INT';
	if (['REAL', 'DOUBLE', 'FLOAT', 'NUMERIC'].includes(type)) return 'DECIMAL';
	if (['BLOB', 'TEXT', 'VARCHAR', 'CHAR', 'BOOLEAN', 'DATE', 'DATETIME', 'TIMESTAMP', 'JSON'].includes(type)) return type;
	return 'TEXT';
}

function stripSqlString(value: string): string {
	return /^'.*'$/.test(value) ? value.slice(1, -1).replaceAll("''", "'") : value;
}