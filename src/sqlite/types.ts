export interface SqliteEditorMessage {
	type: 'ready' | 'refresh' | 'openTable' | 'deleteTable' | 'openSql' | 'loadTableDefinition' | 'previewCreateTable' | 'previewAlterTable' | 'confirmTableStatement';
	database?: unknown;
	table?: unknown;
	definition?: unknown;
	confirmationId?: unknown;
}

export interface SqliteTablePreviewMessage {
	type: 'ready' | 'loadPage' | 'refresh' | 'previewUpdateRow' | 'confirmRowUpdate' | 'previewInsertRow' | 'confirmRowInsert' | 'deleteRow';
	page?: unknown;
	pageSize?: unknown;
	sort?: unknown;
	filters?: unknown;
	rowId?: unknown;
	values?: unknown;
	confirmationId?: unknown;
}

export interface SqliteColumnDefinition {
	name: string;
	originalName?: string;
	type: string;
	length: string;
	nullable: boolean;
	primaryKey: boolean;
	autoIncrement: boolean;
	defaultKind: 'none' | 'null' | 'currentTimestamp' | 'value';
	defaultValue: string;
}

export interface SqliteTableDefinition {
	name: string;
	columns: SqliteColumnDefinition[];
}