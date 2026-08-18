import { useEffect, useState } from 'react';
import { vscode } from '../../../../vscodeApi';
import type { SqliteOverviewExtensionMessage, SqliteTableColumnDefinition, SqliteTableDefinition, SqliteTableInfo } from '../types';

type DialogState = { mode: 'create' | 'edit'; originalTable?: string; definition: SqliteTableDefinition; loading?: boolean; sql?: string; confirmationId?: string };

const defaultColumn = (): SqliteTableColumnDefinition => ({ name: '', type: 'VARCHAR', length: '', nullable: false, primaryKey: false, autoIncrement: false, defaultKind: 'none', defaultValue: '' });
const defaultDefinition = (): SqliteTableDefinition => ({ name: '', columns: [{ ...defaultColumn(), name: 'id', type: 'BIGINT', primaryKey: true, autoIncrement: true }, { ...defaultColumn(), name: 'name', length: '255' }] });

export function useSqliteOverview() {
	const [server, setServer] = useState<{ name: string; address: string; database: string }>();
	const [tables, setTables] = useState<SqliteTableInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');
	const [dialog, setDialog] = useState<DialogState>();

	useEffect(() => {
		const handleMessage = (event: MessageEvent<SqliteOverviewExtensionMessage>) => {
			const message = event.data;
			switch (message.type) {
				case 'initialize': setServer(message.server); break;
				case 'titleOpenSql': vscode.postMessage({ type: 'openSql' }); break;
				case 'titleCreateTable': setError(''); setDialog({ mode: 'create', definition: defaultDefinition() }); break;
				case 'titleRefresh': vscode.postMessage({ type: 'refresh' }); break;
				case 'tablesLoading': setLoading(true); setError(''); break;
				case 'tables': setTables(message.tables); setLoading(false); setError(''); break;
				case 'connectionError': case 'tablesError': setLoading(false); setError(message.message); break;
				case 'tableDefinition': setDialog(current => current?.mode === 'edit' ? { ...current, loading: false, definition: message.definition } : current); break;
				case 'tableDefinitionError': case 'tableCreateError': setDialog(current => current ? { ...current, loading: false } : current); setError(message.message); break;
				case 'tableStatementPreview': setDialog(current => current ? { ...current, sql: message.sql, confirmationId: message.confirmationId } : current); break;
				case 'tableStatementExecuted': setDialog(undefined); break;
			}
		};
		window.addEventListener('message', handleMessage);
		vscode.postMessage({ type: 'ready' });
		return () => window.removeEventListener('message', handleMessage);
	}, []);

	const updateDefinition = (definition: SqliteTableDefinition) => setDialog(current => current ? { ...current, definition, sql: undefined, confirmationId: undefined } : current);
	const preview = () => dialog && vscode.postMessage({ type: dialog.mode === 'create' ? 'previewCreateTable' : 'previewAlterTable', table: dialog.originalTable, definition: dialog.definition });
	return {
		server, tables, loading, error, dialog, updateDefinition, preview,
		refresh: () => vscode.postMessage({ type: 'refresh' }),
		openSql: () => vscode.postMessage({ type: 'openSql' }), openTable: (table: string) => vscode.postMessage({ type: 'openTable', table }), deleteTable: (table: string) => vscode.postMessage({ type: 'deleteTable', table }),
		openCreate: () => { setError(''); setDialog({ mode: 'create', definition: defaultDefinition() }); },
		openEdit: (table: string) => { setError(''); setDialog({ mode: 'edit', originalTable: table, definition: { name: table, columns: [] }, loading: true }); vscode.postMessage({ type: 'loadTableDefinition', table }); },
		closeDialog: () => setDialog(undefined), backToFields: () => setDialog(current => current ? { ...current, sql: undefined, confirmationId: undefined } : current),
		confirm: () => dialog?.confirmationId && vscode.postMessage({ type: 'confirmTableStatement', confirmationId: dialog.confirmationId }),
		addColumn: () => dialog && updateDefinition({ ...dialog.definition, columns: [...dialog.definition.columns, defaultColumn()] }),
	};
}