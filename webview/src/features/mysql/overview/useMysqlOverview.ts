import { useEffect, useRef, useState } from 'react';
import { vscode } from '../../../vscodeApi';
import type { MysqlOverviewExtensionMessage, MysqlTableColumnDefinition, MysqlTableDefinition, MysqlTableInfo } from '../types';

type DialogState = { mode: 'create' | 'edit'; originalTable?: string; definition: MysqlTableDefinition; loading?: boolean; sql?: string; confirmationId?: string };

const defaultColumn = (): MysqlTableColumnDefinition => ({ name: '', type: 'VARCHAR', length: '', nullable: false, primaryKey: false, autoIncrement: false, defaultKind: 'none', defaultValue: '' });
const defaultDefinition = (): MysqlTableDefinition => ({ name: '', columns: [{ ...defaultColumn(), name: 'id', type: 'BIGINT', primaryKey: true, autoIncrement: true }, { ...defaultColumn(), name: 'name', length: '255' }] });

export function useMysqlOverview() {
	const persisted = vscode.getState() as { database?: string } | undefined;
	const [server, setServer] = useState<{ name: string; address: string; database: string }>();
	const [databases, setDatabases] = useState<string[]>([]);
	const [database, setDatabaseState] = useState(persisted?.database ?? '');
	const [tables, setTables] = useState<MysqlTableInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');
	const [dialog, setDialog] = useState<DialogState>();
	const databaseRef = useRef(database);
	databaseRef.current = database;

	useEffect(() => {
		const handleMessage = (event: MessageEvent<MysqlOverviewExtensionMessage>) => {
			const message = event.data;
			switch (message.type) {
				case 'initialize': setServer(message.server); setDatabaseState(current => current || message.server.database); break;
				case 'databases': {
					setDatabases(message.databases);
					const nextDatabase = message.forceSelection || !message.databases.includes(databaseRef.current) ? message.selectedDatabase : databaseRef.current;
					databaseRef.current = nextDatabase;
					setDatabaseState(nextDatabase);
					break;
				}
				case 'tablesLoading': if (message.database === databaseRef.current) { setLoading(true); setError(''); } break;
				case 'tables': if (message.database === databaseRef.current) { setTables(message.tables); setLoading(false); setError(''); } break;
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

	useEffect(() => { vscode.setState({ database }); }, [database]);
	const setDatabase = (value: string) => { databaseRef.current = value; setDatabaseState(value); setLoading(true); setTables([]); vscode.postMessage({ type: 'selectDatabase', database: value }); };
	const updateDefinition = (definition: MysqlTableDefinition) => setDialog(current => current ? { ...current, definition, sql: undefined, confirmationId: undefined } : current);
	const preview = () => dialog && vscode.postMessage({ type: dialog.mode === 'create' ? 'previewCreateTable' : 'previewAlterTable', database, table: dialog.originalTable, definition: dialog.definition });
	return {
		server, databases, database, tables, loading, error, dialog, setDatabase, updateDefinition, preview,
		refresh: () => vscode.postMessage({ type: 'refresh' }), createDatabase: () => vscode.postMessage({ type: 'createDatabase' }),
		deleteDatabase: () => vscode.postMessage({ type: 'deleteDatabase', database }), importDatabase: () => vscode.postMessage({ type: 'importDatabase' }), exportDatabase: () => vscode.postMessage({ type: 'exportDatabase', database }),
		openSql: () => vscode.postMessage({ type: 'openSql', database }), openTable: (table: string) => vscode.postMessage({ type: 'openTable', database, table }), deleteTable: (table: string) => vscode.postMessage({ type: 'deleteTable', database, table }),
		openCreate: () => { setError(''); setDialog({ mode: 'create', definition: defaultDefinition() }); },
		openEdit: (table: string) => { setError(''); setDialog({ mode: 'edit', originalTable: table, definition: { name: table, columns: [] }, loading: true }); vscode.postMessage({ type: 'loadTableDefinition', database, table }); },
		closeDialog: () => setDialog(undefined), backToFields: () => setDialog(current => current ? { ...current, sql: undefined, confirmationId: undefined } : current),
		confirm: () => dialog?.confirmationId && vscode.postMessage({ type: 'confirmTableStatement', confirmationId: dialog.confirmationId }),
		addColumn: () => dialog && updateDefinition({ ...dialog.definition, columns: [...dialog.definition.columns, defaultColumn()] }),
	};
}