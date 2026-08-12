import { ArrowDown, ArrowUp, ChevronsUpDown, LoaderCircle, Pencil, Plus, RefreshCw, Trash2 } from '../../../components/icons';
import { useEffect, useState } from 'react';
import { IconButton, PrimaryButton, SelectInput, TextArea, TextInput } from '../../../components/ui';
import { Dialog } from '../components/Dialog';
import { SqlPreview } from '../components/SqlPreview';
import type { MysqlColumnInfo, MysqlTableFilter } from '../types';
import { useMysqlTablePreview } from './useMysqlTablePreview';

const pageSizes = [50, 100, 300, 500, 1000];

export function App() {
	const preview = useMysqlTablePreview();
	const [filters, setFilters] = useState<Record<string, string>>({});
	useEffect(() => {
		if (!preview.data) return;
		setFilters(Object.fromEntries(preview.data.filters.map(filter => [filter.column, filter.value])));
	}, [preview.data?.filters]);
	useEffect(() => {
		if (!preview.data) return;
		const timer = window.setTimeout(() => {
			const next = Object.entries(filters).filter(([, value]) => value !== '').map(([column, value]) => ({ column, value }));
			if (JSON.stringify(next) !== JSON.stringify(preview.data!.filters)) preview.loadPage(1, preview.data!.pageSize, preview.data!.sort, next);
		}, 350);
		return () => window.clearTimeout(timer);
	}, [filters]);

	if (!preview.identity) return <div className="grid h-screen place-items-center"><LoaderCircle className="animate-spin" /></div>;
	const data = preview.data;
	return <div className="grid h-screen grid-rows-[44px_minmax(0,1fr)_42px] overflow-hidden">
		<header className="flex min-w-0 items-center gap-2 border-b border-border px-3"><strong className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{preview.identity.database} / {preview.identity.table}</strong>{data && <span className="text-xs text-muted">{new Intl.NumberFormat().format(data.totalRows)} rows</span>}<span className="ml-auto flex gap-1"><IconButton className="border-0" title="Insert row" onClick={preview.openInsert}><Plus size={16} /></IconButton><IconButton className="border-0" title="Refresh" onClick={preview.refresh}><RefreshCw size={16} /></IconButton></span></header>
		<main className="min-h-0 overflow-auto">{preview.loading && !data ? <Status loading>Loading table...</Status> : preview.error && !data ? <Status error>{preview.error}</Status> : data ? <Table preview={preview} filters={filters} setFilters={setFilters} /> : null}</main>
		<footer className="flex items-center gap-2 border-t border-border px-3 text-xs"><span>Rows per page</span><SelectInput className="h-7 w-20" value={data?.pageSize ?? 100} onChange={event => data && preview.loadPage(1, Number(event.target.value), data.sort, data.filters)}>{pageSizes.map(size => <option key={size}>{size}</option>)}</SelectInput><span className="ml-auto">Page {data?.page ?? 1} of {data?.totalPages ?? 1}</span><PrimaryButton className="h-7" disabled={!data || preview.loading || data.page <= 1} onClick={() => data && preview.loadPage(data.page - 1)}>Previous</PrimaryButton><PrimaryButton className="h-7" disabled={!data || preview.loading || data.page >= data.totalPages} onClick={() => data && preview.loadPage(data.page + 1)}>Next</PrimaryButton></footer>
		{preview.dialog && data && <RowDialog preview={preview} />}
	</div>;
}

type PreviewState = ReturnType<typeof useMysqlTablePreview>;
function Table({ preview, filters, setFilters }: { preview: PreviewState; filters: Record<string, string>; setFilters: React.Dispatch<React.SetStateAction<Record<string, string>>> }) {
	const data = preview.data!;
	const toggleSort = (column: string) => {
		const sort = data.sort?.column !== column ? { column, direction: 'asc' as const } : data.sort.direction === 'asc' ? { column, direction: 'desc' as const } : undefined;
		preview.loadPage(1, data.pageSize, sort, data.filters);
	};
	return <table className="min-w-full border-collapse whitespace-nowrap"><thead><tr>{data.columns.map(column => { const active = data.sort?.column === column; const SortIcon = !active ? ChevronsUpDown : data.sort?.direction === 'asc' ? ArrowUp : ArrowDown; return <th key={column} className="sticky top-0 z-10 min-w-40 border-r border-b border-border bg-app p-0 text-left"><button className="flex h-8 w-full items-center gap-1 border-0 bg-transparent px-2 text-left text-xs font-semibold" onClick={() => toggleSort(column)}>{column}<SortIcon className="ml-auto" size={13} /></button><TextInput className="h-7 border-x-0 border-b-0 text-xs font-normal" placeholder="Filter" value={filters[column] ?? ''} onChange={event => setFilters(current => ({ ...current, [column]: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter') { const next: MysqlTableFilter[] = Object.entries(filters).filter(([, value]) => value).map(([name, value]) => ({ column: name, value })); preview.loadPage(1, data.pageSize, data.sort, next); } }} /></th>; })}<th className="sticky top-0 z-10 w-20 border-b border-border bg-app"></th></tr></thead><tbody>{data.rows.map(row => <tr key={row.rowId} className="hover:bg-hover">{row.values.map((value, index) => <td key={data.columns[index]} className={`max-w-80 overflow-hidden border-r border-b border-border px-2 py-1.5 text-ellipsis ${value === null ? 'italic text-muted' : ''}`} title={value ?? 'NULL'}>{value ?? 'NULL'}</td>)}<td className="border-b border-border px-1"><span className="flex"><IconButton className="border-0" disabled={!data.canEdit} title={data.canEdit ? 'Edit row' : data.editDisabledReason} onClick={() => preview.openUpdate(row)}><Pencil size={14} /></IconButton><IconButton className="border-0" disabled={!data.canEdit} title={data.canEdit ? 'Delete row' : data.editDisabledReason} onClick={() => preview.deleteRow(row.rowId)}><Trash2 size={14} /></IconButton></span></td></tr>)}</tbody></table>;
}

function RowDialog({ preview }: { preview: PreviewState }) {
	const data = preview.data!;
	const dialog = preview.dialog!;
	const columns = data.columnInfo.filter(column => column.editable && !(dialog.mode === 'insert' && column.autoIncrement));
	return <Dialog title={dialog.mode === 'insert' ? 'Insert row' : 'Edit row'} onClose={preview.closeDialog} actions={dialog.sql ? <><PrimaryButton className="bg-button-secondary text-button-secondary-foreground hover:bg-button-secondary-hover" onClick={preview.backToFields}>Back</PrimaryButton><PrimaryButton onClick={preview.confirm}>Execute</PrimaryButton></> : <PrimaryButton onClick={preview.preview}>Review SQL</PrimaryButton>}>
		{dialog.sql ? <SqlPreview sql={dialog.sql} /> : <div className="grid gap-3">{columns.map(column => <RowField key={column.name} column={column} preview={preview} />)}</div>}
	</Dialog>;
}

function RowField({ column, preview }: { column: MysqlColumnInfo; preview: PreviewState }) {
	const dialog = preview.dialog!;
	const isNull = dialog.nulls.has(column.name);
	const useDefault = dialog.defaults.has(column.name);
	const disabled = isNull || useDefault;
	const value = dialog.values[column.name] ?? '';
	const control = column.boolean ? <SelectInput disabled={disabled} value={value || 'false'} onChange={event => preview.setValue(column.name, event.target.value)}><option value="false">false</option><option value="true">true</option></SelectInput> : ['text','mediumtext','longtext','json'].includes(column.dataType.toLowerCase()) ? <TextArea disabled={disabled} value={value} onChange={event => preview.setValue(column.name, event.target.value)} /> : <TextInput disabled={disabled} type={inputType(column.dataType)} required={dialog.mode === 'insert' && !column.nullable && !column.hasDefault} value={value} onChange={event => preview.setValue(column.name, event.target.value)} />;
	return <label><span className="mb-1 flex items-center gap-3 text-xs font-semibold"><span>{column.name}<small className="ml-1 font-normal text-muted">{column.dataType}</small></span>{column.nullable && <span className="ml-auto font-normal"><input type="checkbox" checked={isNull} onChange={event => preview.toggleNull(column.name, event.target.checked)} /> NULL</span>}{dialog.mode === 'insert' && column.hasDefault && <span className="font-normal"><input type="checkbox" checked={useDefault} onChange={event => preview.toggleDefault(column.name, event.target.checked)} /> DEFAULT</span>}</span>{control}</label>;
}

function inputType(dataType: string) { const type = dataType.toLowerCase(); if (type === 'date') return 'date'; if (type === 'time') return 'time'; if (['tinyint','smallint','mediumint','int','bigint','decimal','float','double'].includes(type)) return 'number'; return 'text'; }
function Status({ children, loading, error }: { children: React.ReactNode; loading?: boolean; error?: boolean }) { return <div className={`flex items-center justify-center gap-2 p-8 ${error ? 'text-error' : 'text-muted'}`}>{loading && <LoaderCircle className="animate-spin" size={17} />}{children}</div>; }