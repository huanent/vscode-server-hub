export interface SqliteTableInfo {
	name: string;
	engine: string;
	rowCount: number;
	dataSize: number;
	indexSize: number;
	updatedAt: string | null;
	collation: string;
}

export type SqliteColumnType = 'BIGINT' | 'INT' | 'SMALLINT' | 'TINYINT' | 'BIT' | 'DECIMAL' | 'VARCHAR' | 'CHAR' | 'TEXT' | 'LONGTEXT' | 'BOOLEAN' | 'DATE' | 'DATETIME' | 'TIMESTAMP' | 'TIME' | 'JSON' | 'BLOB';
export type SqliteDefaultKind = 'none' | 'null' | 'currentTimestamp' | 'value';

export interface SqliteTableColumnDefinition {
	name: string;
	originalName?: string;
	type: SqliteColumnType;
	length: string;
	nullable: boolean;
	primaryKey: boolean;
	autoIncrement: boolean;
	defaultKind: SqliteDefaultKind;
	defaultValue: string;
}

export interface SqliteTableDefinition {
	name: string;
	columns: SqliteTableColumnDefinition[];
}

export type SqliteOverviewExtensionMessage =
	| { type: 'initialize'; server: { name: string; address: string; database: string } }
	| { type: 'titleOpenSql' }
	| { type: 'titleCreateTable' }
	| { type: 'titleRefresh' }
	| { type: 'tablesLoading'; database: string }
	| { type: 'tables'; database: string; tables: SqliteTableInfo[] }
	| { type: 'connectionError'; message: string }
	| { type: 'tablesError'; message: string }
	| { type: 'tableDefinition'; table: string; definition: SqliteTableDefinition }
	| { type: 'tableDefinitionError'; message: string }
	| { type: 'tableStatementPreview'; confirmationId: string; sql: string }
	| { type: 'tableStatementExecuted' }
	| { type: 'tableCreateError'; message: string };

export interface SqliteTableSort { column: string; direction: 'asc' | 'desc' }
export interface SqliteTableFilter { column: string; value: string }
export interface SqliteColumnInfo { name: string; dataType: string; boolean: boolean; nullable: boolean; primaryKey: boolean; autoIncrement: boolean; hasDefault: boolean; editable: boolean }
export interface SqlitePreviewRow { rowId: string; values: Array<string | null>; editValues: Array<string | null> }

export type SqliteTablePreviewExtensionMessage =
	| { type: 'initialize'; database: string; table: string }
	| { type: 'tableLoading' }
	| { type: 'tableData'; columns: string[]; columnInfo: SqliteColumnInfo[]; rows: SqlitePreviewRow[]; canEdit: boolean; editDisabledReason?: string; page: number; pageSize: number; totalRows: number; totalPages: number; sort?: SqliteTableSort; filters: SqliteTableFilter[] }
	| { type: 'tableError'; message: string }
	| { type: 'rowUpdatePreview'; confirmationId: string; sql: string }
	| { type: 'rowUpdateError'; message: string }
	| { type: 'rowUpdated' }
	| { type: 'rowInsertPreview'; confirmationId: string; sql: string }
	| { type: 'rowInsertError'; message: string }
	| { type: 'rowInserted' };