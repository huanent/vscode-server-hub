import { useEffect, useState } from 'react';
import { vscode } from '../../../vscodeApi';
import type { MysqlColumnInfo, MysqlPreviewRow, MysqlTableFilter, MysqlTablePreviewExtensionMessage, MysqlTableSort } from '../types';

interface TableData {
	columns: string[];
	columnInfo: MysqlColumnInfo[];
	rows: MysqlPreviewRow[];
	canEdit: boolean;
	editDisabledReason?: string;
	page: number;
	pageSize: number;
	totalRows: number;
	totalPages: number;
	sort?: MysqlTableSort;
	filters: MysqlTableFilter[];
}

interface RowDialog {
	mode: 'insert' | 'update';
	row?: MysqlPreviewRow;
	values: Record<string, string>;
	nulls: Set<string>;
	defaults: Set<string>;
	sql?: string;
	confirmationId?: string;
}

export function useMysqlTablePreview() {
	const [identity, setIdentity] = useState<{ database: string; table: string }>();
	const [data, setData] = useState<TableData>();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');
	const [dialog, setDialog] = useState<RowDialog>();

	useEffect(() => {
		const handleMessage = (event: MessageEvent<MysqlTablePreviewExtensionMessage>) => {
			const message = event.data;
			switch (message.type) {
				case 'initialize': setIdentity({ database: message.database, table: message.table }); break;
				case 'tableLoading': setLoading(true); setError(''); break;
				case 'tableData': setData(message); setLoading(false); setError(''); break;
				case 'tableError': setLoading(false); setError(message.message); break;
				case 'rowUpdatePreview': case 'rowInsertPreview': setDialog(current => current ? { ...current, sql: message.sql, confirmationId: message.confirmationId } : current); break;
				case 'rowUpdateError': case 'rowInsertError': setError(message.message); break;
				case 'rowUpdated': case 'rowInserted': setDialog(undefined); break;
			}
		};
		window.addEventListener('message', handleMessage);
		vscode.postMessage({ type: 'ready' });
		return () => window.removeEventListener('message', handleMessage);
	}, []);

	const loadPage = (page: number, pageSize = data?.pageSize ?? 100, sort = data?.sort, filters = data?.filters ?? []) => vscode.postMessage({ type: 'loadPage', page, pageSize, sort, filters });
	const openInsert = () => {
		if (!data) return;
		const defaults = new Set(data.columnInfo.filter(column => column.editable && !column.autoIncrement && column.hasDefault).map(column => column.name));
		setDialog({ mode: 'insert', values: {}, nulls: new Set(), defaults });
	};
	const openUpdate = (row: MysqlPreviewRow) => {
		if (!data) return;
		const values: Record<string, string> = {};
		const nulls = new Set<string>();
		data.columns.forEach((column, index) => { const value = row.editValues[index]; if (value === null) nulls.add(column); else values[column] = value; });
		setDialog({ mode: 'update', row, values, nulls, defaults: new Set() });
	};
	const preview = () => {
		if (!data || !dialog) return;
		const values: Record<string, string | null> = {};
		for (const column of data.columnInfo) {
			if (!column.editable || dialog.mode === 'insert' && (column.autoIncrement || dialog.defaults.has(column.name))) continue;
			const value = dialog.nulls.has(column.name) ? null : dialog.values[column.name] ?? '';
			if (dialog.mode === 'update') {
				const index = data.columns.indexOf(column.name);
				if (value === dialog.row?.editValues[index]) continue;
			}
			values[column.name] = value;
		}
		if (dialog.mode === 'update' && Object.keys(values).length === 0) { setDialog(undefined); return; }
		vscode.postMessage({ type: dialog.mode === 'insert' ? 'previewInsertRow' : 'previewUpdateRow', rowId: dialog.row?.rowId, values });
	};
	return {
		identity, data, loading, error, dialog, loadPage, openInsert, openUpdate, preview,
		refresh: () => vscode.postMessage({ type: 'refresh' }), deleteRow: (rowId: string) => vscode.postMessage({ type: 'deleteRow', rowId }),
		closeDialog: () => setDialog(undefined), backToFields: () => setDialog(current => current ? { ...current, sql: undefined, confirmationId: undefined } : current),
		confirm: () => dialog?.confirmationId && vscode.postMessage({ type: dialog.mode === 'insert' ? 'confirmRowInsert' : 'confirmRowUpdate', confirmationId: dialog.confirmationId }),
		setValue: (column: string, value: string) => setDialog(current => current ? { ...current, values: { ...current.values, [column]: value } } : current),
		toggleNull: (column: string, enabled: boolean) => setDialog(current => { if (!current) return current; const nulls = new Set(current.nulls); enabled ? nulls.add(column) : nulls.delete(column); const defaults = new Set(current.defaults); if (enabled) defaults.delete(column); return { ...current, nulls, defaults }; }),
		toggleDefault: (column: string, enabled: boolean) => setDialog(current => { if (!current) return current; const defaults = new Set(current.defaults); enabled ? defaults.add(column) : defaults.delete(column); const nulls = new Set(current.nulls); if (enabled) nulls.delete(column); return { ...current, nulls, defaults }; }),
	};
}