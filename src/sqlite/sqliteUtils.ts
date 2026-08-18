import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { MysqlColumnInfo } from '../mysql/types';

export const sqliteTablePageSizes = new Set([50, 100, 300, 500, 1000]);

export interface SqliteTableSort {
	column: string;
	direction: 'asc' | 'desc';
}

export interface SqliteTableFilter {
	column: string;
	value: string;
}

export interface SqliteColumnMetadata extends MysqlColumnInfo {
	defaultValue: unknown;
	primaryKeyOrder: number;
}

export function quoteIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

export function quoteValue(value: unknown): string {
	if (value === null) return 'NULL';
	if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
	if (typeof value === 'number' || typeof value === 'bigint') return String(value);
	return `'${String(value).replaceAll("'", "''")}'`;
}

export function displaySqliteValue(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
	return String(value);
}

export function parseSqliteValue(value: string | null, column: MysqlColumnInfo): SQLInputValue {
	if (value === null) return null;
	if (column.boolean && (value === 'true' || value === 'false')) return value === 'true' ? 1 : 0;
	if (/^(blob|binary|varbinary)$/i.test(column.dataType) && /^0x[\da-f]*$/i.test(value)) {
		return Buffer.from(value.slice(2), 'hex');
	}
	return value;
}

export function readColumnMetadata(database: DatabaseSync, table: string): SqliteColumnMetadata[] {
	const rows = database.prepare('SELECT name, type, "notnull" AS not_null, dflt_value AS default_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid').all(table) as Array<Record<string, unknown>>;
	return rows.map(row => {
		const dataType = String(row.type || 'TEXT');
		const primaryKeyOrder = Number(row.pk) || 0;
		const autoIncrement = primaryKeyOrder === 1 && /^(integer|int)$/i.test(dataType);
		return {
			name: String(row.name),
			dataType,
			boolean: /^(boolean|bool)$/i.test(dataType),
			nullable: !Boolean(row.not_null) && primaryKeyOrder === 0,
			primaryKey: primaryKeyOrder > 0,
			primaryKeyOrder,
			autoIncrement,
			hasDefault: row.default_value !== null,
			defaultValue: row.default_value,
			editable: Number(row.hidden) === 0,
		};
	});
}

export function parseTableSort(value: unknown, columnNames: Set<string>): SqliteTableSort | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const sort = value as Record<string, unknown>;
	return typeof sort.column === 'string' && columnNames.has(sort.column) && (sort.direction === 'asc' || sort.direction === 'desc')
		? { column: sort.column, direction: sort.direction }
		: undefined;
}

export function parseTableFilters(value: unknown, columnNames: Set<string>): SqliteTableFilter[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap(item => {
		if (!item || typeof item !== 'object') return [];
		const filter = item as Record<string, unknown>;
		return typeof filter.column === 'string' && columnNames.has(filter.column) && typeof filter.value === 'string' && filter.value
			? [{ column: filter.column, value: filter.value }]
			: [];
	});
}

export function buildFilterClause(filters: SqliteTableFilter[]): { sql: string; parameters: SQLInputValue[] } {
	if (filters.length === 0) return { sql: '', parameters: [] };
	const parameters: SQLInputValue[] = [];
	const clauses = filters.map(filter => {
		if (filter.value === 'NULL') return `${quoteIdentifier(filter.column)} IS NULL`;
		parameters.push(filter.value.includes('%') ? filter.value : `%${filter.value}%`);
		return `CAST(${quoteIdentifier(filter.column)} AS TEXT) LIKE ?`;
	});
	return { sql: ` WHERE ${clauses.join(' AND ')}`, parameters };
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}