import { RowDataPacket } from 'mysql2/promise';
import { MysqlColumnInfo, MysqlTableFilter, MysqlTableInfo, MysqlTableSort } from './types';

export const mysqlTablePageSizes = new Set([50, 100, 300, 500, 1000]);

export function parseRowChanges(
	value: unknown,
	editableColumnNames: Set<string>,
	columnInfo: MysqlColumnInfo[],
): Array<{ column: string; value: unknown }> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return [];
	}
	const values = value as Record<string, unknown>;
	const metadata = new Map(columnInfo.map(column => [column.name, column]));
	return Object.entries(values).flatMap(([column, fieldValue]) => {
		if (!editableColumnNames.has(column) || (fieldValue !== null && typeof fieldValue !== 'string')) {
			return [];
		}
		const info = metadata.get(column);
		if (!info || (fieldValue === null && !info.nullable)) {
			return [];
		}
		return [{ column, value: parseEditValue(fieldValue, info) }];
	});
}

export function parseTableSort(value: unknown, columnNames: Set<string>): MysqlTableSort | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const sort = value as Record<string, unknown>;
	return typeof sort.column === 'string'
		&& columnNames.has(sort.column)
		&& (sort.direction === 'asc' || sort.direction === 'desc')
		? { column: sort.column, direction: sort.direction }
		: undefined;
}

export function parseTableFilters(value: unknown, columnNames: Set<string>): MysqlTableFilter[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap(item => {
		if (!item || typeof item !== 'object') {
			return [];
		}
		const filter = item as Record<string, unknown>;
		return typeof filter.column === 'string'
			&& columnNames.has(filter.column)
			&& typeof filter.value === 'string'
			&& filter.value.length > 0
			? [{ column: filter.column, value: filter.value }]
			: [];
	});
}

export function normalizeTableInfo(row: RowDataPacket): MysqlTableInfo {
	return {
		name: String(row.name),
		engine: row.engine ? String(row.engine) : '',
		rowCount: Number(row.rowCount) || 0,
		dataSize: Number(row.dataSize) || 0,
		indexSize: Number(row.indexSize) || 0,
		updatedAt: row.updatedAt ? String(row.updatedAt) : null,
		collation: row.collation ? String(row.collation) : '',
	};
}

export function displayMysqlValue(value: unknown, boolean: boolean = false): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (boolean) {
		if (Buffer.isBuffer(value)) {
			return value.some(byte => byte !== 0) ? 'true' : 'false';
		}
		return value ? 'true' : 'false';
	}
	if (Buffer.isBuffer(value)) {
		return `0x${value.toString('hex')}`;
	}
	if (typeof value === 'object') {
		return JSON.stringify(value);
	}
	return String(value);
}

function parseEditValue(value: string | null, column: MysqlColumnInfo): unknown {
	if (value === null) {
		return null;
	}
	if (column.boolean && (value === 'true' || value === 'false')) {
		return value === 'true';
	}
	if (['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit'].includes(column.dataType) && /^0x[\da-f]*$/i.test(value)) {
		return Buffer.from(value.slice(2), 'hex');
	}
	return value;
}