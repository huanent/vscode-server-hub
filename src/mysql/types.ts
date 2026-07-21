export interface MysqlEditorMessage {
	type: 'selectDatabase' | 'refresh' | 'openTable' | 'openSql';
	database?: unknown;
	table?: unknown;
}

export interface MysqlTablePreviewMessage {
	type: 'loadPage' | 'updateRow';
	page?: unknown;
	pageSize?: unknown;
	sort?: unknown;
	filters?: unknown;
	rowId?: unknown;
	values?: unknown;
}

export interface MysqlTableSort {
	column: string;
	direction: 'asc' | 'desc';
}

export interface MysqlTableFilter {
	column: string;
	value: string;
}

export interface MysqlColumnInfo {
	name: string;
	dataType: string;
	boolean: boolean;
	nullable: boolean;
	primaryKey: boolean;
	editable: boolean;
}

export interface MysqlTableInfo {
	name: string;
	engine: string;
	rowCount: number;
	dataSize: number;
	indexSize: number;
	updatedAt: string | null;
	collation: string;
}