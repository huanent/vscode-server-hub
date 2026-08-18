import * as vscode from 'vscode';
import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { MysqlColumnInfo } from '../mysql/types';
import { getWebviewHtml } from '../webview';
import { SqliteTablePreviewMessage } from './types';
import {
	buildFilterClause,
	displaySqliteValue,
	errorMessage,
	parseSqliteValue,
	parseTableFilters,
	parseTableSort,
	quoteIdentifier,
	quoteValue,
	readColumnMetadata,
	sqliteTablePageSizes,
	SqliteTableFilter,
	SqliteTableSort,
} from './sqliteUtils';

export function openSqliteTablePreview(context: vscode.ExtensionContext, uri: vscode.Uri, table: string): void {
	const databaseName = uri.path.split('/').pop() ?? uri.fsPath;
	const panel = vscode.window.createWebviewPanel(
		'server-hub.sqliteTablePreview',
		`${table} - ${databaseName}`,
		vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] },
	);
	panel.iconPath = new vscode.ThemeIcon('table');
	panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri, 'sqliteTablePreview', `${table} - ${databaseName}`);
	const database = new DatabaseSync(uri.fsPath);
	let columns: string[] = [];
	let columnInfo: MysqlColumnInfo[] = [];
	let columnNames = new Set<string>();
	let editableColumnNames = new Set<string>();
	let keyColumns: string[] = [];
	let useRowId = false;
	let pageRows = new Map<string, Record<string, unknown>>();
	let currentRequest = { page: 1, pageSize: 100, sort: undefined as SqliteTableSort | undefined, filters: [] as SqliteTableFilter[] };
	let pendingUpdate: { id: string; sql: string; parameters: SQLInputValue[] } | undefined;
	let pendingInsert: { id: string; sql: string; parameters: SQLInputValue[] } | undefined;
	panel.onDidDispose(() => database.close());
	panel.webview.onDidReceiveMessage(async (message: SqliteTablePreviewMessage) => {
		if (message.type === 'ready') {
			await panel.webview.postMessage({ type: 'initialize', database: databaseName, table });
			connectAndLoad();
			return;
		}
		if (message.type === 'refresh') return loadPage(currentRequest.page, currentRequest.pageSize, currentRequest.sort, currentRequest.filters);
		if (message.type === 'previewUpdateRow') return previewUpdate(message.rowId, message.values);
		if (message.type === 'confirmRowUpdate') return confirmUpdate(message.confirmationId);
		if (message.type === 'previewInsertRow') return previewInsert(message.values);
		if (message.type === 'confirmRowInsert') return confirmInsert(message.confirmationId);
		if (message.type === 'deleteRow') return deleteRow(message.rowId);
		if (message.type !== 'loadPage' || !Number.isInteger(message.page) || Number(message.page) < 1 || typeof message.pageSize !== 'number' || !sqliteTablePageSizes.has(message.pageSize)) return;
		loadPage(Number(message.page), message.pageSize, parseTableSort(message.sort, columnNames), parseTableFilters(message.filters, columnNames));
	});

	function connectAndLoad(): void {
		try {
			const metadata = readColumnMetadata(database, table);
			columns = metadata.map(column => column.name);
			columnInfo = metadata;
			columnNames = new Set(columns);
			editableColumnNames = new Set(metadata.filter(column => column.editable).map(column => column.name));
			keyColumns = metadata.filter(column => column.primaryKey).sort((left, right) => left.primaryKeyOrder - right.primaryKeyOrder).map(column => column.name);
			const schema = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as { sql?: string } | undefined;
			useRowId = keyColumns.length === 0 && !/\bWITHOUT\s+ROWID\b/i.test(schema?.sql ?? '');
			loadPage(1, 100, undefined, []);
		} catch (error) {
			void panel.webview.postMessage({ type: 'tableError', message: errorMessage(error) });
		}
	}

	function loadPage(page: number, pageSize: number, sort: SqliteTableSort | undefined, filters: SqliteTableFilter[]): void {
		pendingUpdate = undefined;
		pendingInsert = undefined;
		currentRequest = { page, pageSize, sort, filters };
		void panel.webview.postMessage({ type: 'tableLoading' });
		try {
			const filter = buildFilterClause(filters);
			const total = Number((database.prepare(`SELECT COUNT(*) AS total FROM ${quoteIdentifier(table)}${filter.sql}`).get(...filter.parameters) as { total: number | bigint }).total);
			const totalPages = Math.max(1, Math.ceil(total / pageSize));
			const currentPage = Math.min(page, totalPages);
			const order = sort ? ` ORDER BY ${quoteIdentifier(sort.column)} ${sort.direction === 'asc' ? 'ASC' : 'DESC'}` : '';
			const rowIdColumn = useRowId ? `rowid AS ${quoteIdentifier('__server_hub_rowid__')}, ` : '';
			const rows = database.prepare(`SELECT ${rowIdColumn}* FROM ${quoteIdentifier(table)}${filter.sql}${order} LIMIT ? OFFSET ?`).all(...filter.parameters, pageSize, (currentPage - 1) * pageSize) as Array<Record<string, unknown>>;
			pageRows = new Map();
			const tableRows = rows.map(row => {
				const rowId = crypto.randomUUID();
				pageRows.set(rowId, row);
				const values = columns.map(column => displaySqliteValue(row[column]));
				return { rowId, values, editValues: values };
			});
			const canEdit = keyColumns.length > 0 || useRowId;
			void panel.webview.postMessage({ type: 'tableData', columns, columnInfo, rows: tableRows, canEdit, editDisabledReason: canEdit ? undefined : 'Rows cannot be edited because this WITHOUT ROWID table has no primary key.', page: currentPage, pageSize, totalRows: total, totalPages, sort, filters });
		} catch (error) {
			void panel.webview.postMessage({ type: 'tableError', message: errorMessage(error) });
		}
	}

	function rowPredicate(row: Record<string, unknown>): { sql: string; parameters: SQLInputValue[] } {
		if (useRowId) return { sql: 'rowid = ?', parameters: [row.__server_hub_rowid__ as SQLInputValue] };
		return { sql: keyColumns.map(column => `${quoteIdentifier(column)} IS ?`).join(' AND '), parameters: keyColumns.map(column => row[column] as SQLInputValue) };
	}

	function parseChanges(value: unknown, allowed: Set<string>): Array<{ column: string; value: SQLInputValue }> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
		const values = value as Record<string, unknown>;
		const metadata = new Map(columnInfo.map(column => [column.name, column]));
		return Object.entries(values).flatMap(([column, fieldValue]) => {
			const info = metadata.get(column);
			if (!allowed.has(column) || !info || (fieldValue !== null && typeof fieldValue !== 'string') || (fieldValue === null && !info.nullable)) return [];
			return [{ column, value: parseSqliteValue(fieldValue, info) }];
		});
	}

	function previewUpdate(rowId: unknown, values: unknown): void {
		if (typeof rowId !== 'string') return;
		const row = pageRows.get(rowId);
		const changes = parseChanges(values, editableColumnNames);
		if (!row || changes.length === 0) return;
		const predicate = rowPredicate(row);
		const sql = `UPDATE ${quoteIdentifier(table)} SET ${changes.map(change => `${quoteIdentifier(change.column)} = ?`).join(', ')} WHERE ${predicate.sql}`;
		const parameters = [...changes.map(change => change.value), ...predicate.parameters];
		pendingUpdate = { id: crypto.randomUUID(), sql, parameters };
		void panel.webview.postMessage({ type: 'rowUpdatePreview', confirmationId: pendingUpdate.id, sql: `${formatSql(sql, parameters)};` });
	}

	function confirmUpdate(confirmationId: unknown): void {
		if (typeof confirmationId !== 'string' || pendingUpdate?.id !== confirmationId) return void panel.webview.postMessage({ type: 'rowUpdateError', message: 'The SQL preview has expired. Review the changes again.' });
		try {
			const result = database.prepare(pendingUpdate.sql).run(...pendingUpdate.parameters);
			if (result.changes !== 1) throw new Error('The row was not updated. It may have changed or been deleted.');
			pendingUpdate = undefined;
			void panel.webview.postMessage({ type: 'rowUpdated' });
			loadPage(currentRequest.page, currentRequest.pageSize, currentRequest.sort, currentRequest.filters);
		} catch (error) { void panel.webview.postMessage({ type: 'rowUpdateError', message: errorMessage(error) }); }
	}

	function previewInsert(values: unknown): void {
		const allowed = new Set(columnInfo.filter(column => column.editable && !column.autoIncrement).map(column => column.name));
		const changes = parseChanges(values, allowed);
		const sql = changes.length ? `INSERT INTO ${quoteIdentifier(table)} (${changes.map(change => quoteIdentifier(change.column)).join(', ')}) VALUES (${changes.map(() => '?').join(', ')})` : `INSERT INTO ${quoteIdentifier(table)} DEFAULT VALUES`;
		const parameters = changes.map(change => change.value);
		pendingInsert = { id: crypto.randomUUID(), sql, parameters };
		void panel.webview.postMessage({ type: 'rowInsertPreview', confirmationId: pendingInsert.id, sql: `${formatSql(sql, parameters)};` });
	}

	function confirmInsert(confirmationId: unknown): void {
		if (typeof confirmationId !== 'string' || pendingInsert?.id !== confirmationId) return void panel.webview.postMessage({ type: 'rowInsertError', message: 'The SQL preview has expired. Review the values again.' });
		try {
			database.prepare(pendingInsert.sql).run(...pendingInsert.parameters);
			pendingInsert = undefined;
			void panel.webview.postMessage({ type: 'rowInserted' });
			loadPage(currentRequest.page, currentRequest.pageSize, currentRequest.sort, currentRequest.filters);
		} catch (error) { void panel.webview.postMessage({ type: 'rowInsertError', message: errorMessage(error) }); }
	}

	async function deleteRow(rowId: unknown): Promise<void> {
		if (typeof rowId !== 'string') return;
		const row = pageRows.get(rowId);
		if (!row || await vscode.window.showWarningMessage(`Delete this row from “${table}”?`, { modal: true }, 'Delete') !== 'Delete') return;
		try {
			const predicate = rowPredicate(row);
			const result = database.prepare(`DELETE FROM ${quoteIdentifier(table)} WHERE ${predicate.sql}`).run(...predicate.parameters);
			if (result.changes !== 1) throw new Error('The row was not deleted. It may have already changed or been deleted.');
			loadPage(currentRequest.page, currentRequest.pageSize, currentRequest.sort, currentRequest.filters);
		} catch (error) { void vscode.window.showErrorMessage(`Could not delete row: ${errorMessage(error)}`); }
	}
}

function formatSql(sql: string, parameters: SQLInputValue[]): string {
	let index = 0;
	return sql.replaceAll('?', () => quoteValue(parameters[index++]));
}