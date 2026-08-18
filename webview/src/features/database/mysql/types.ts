export interface MysqlTableInfo {
	name: string;
	engine: string;
	rowCount: number;
	dataSize: number;
	indexSize: number;
	updatedAt: string | null;
	collation: string;
}

export type MysqlColumnType = 'BIGINT' | 'INT' | 'SMALLINT' | 'TINYINT' | 'BIT' | 'DECIMAL' | 'VARCHAR' | 'CHAR' | 'TEXT' | 'LONGTEXT' | 'BOOLEAN' | 'DATE' | 'DATETIME' | 'TIMESTAMP' | 'TIME' | 'JSON' | 'BLOB';
export type MysqlDefaultKind = 'none' | 'null' | 'currentTimestamp' | 'value';

export interface MysqlTableColumnDefinition {
	name: string;
	originalName?: string;
	type: MysqlColumnType;
	length: string;
	nullable: boolean;
	primaryKey: boolean;
	autoIncrement: boolean;
	defaultKind: MysqlDefaultKind;
	defaultValue: string;
}

export interface MysqlTableDefinition {
	name: string;
	columns: MysqlTableColumnDefinition[];
}

export type MysqlOverviewExtensionMessage =
	| { type: 'initialize'; server: { name: string; address: string; database: string } }
	| { type: 'databases'; databases: string[]; selectedDatabase: string; forceSelection: boolean }
	| { type: 'tablesLoading'; database: string }
	| { type: 'tables'; database: string; tables: MysqlTableInfo[] }
	| { type: 'connectionError'; message: string }
	| { type: 'tablesError'; message: string }
	| { type: 'tableDefinition'; table: string; definition: MysqlTableDefinition }
	| { type: 'tableDefinitionError'; message: string }
	| { type: 'tableStatementPreview'; confirmationId: string; sql: string }
	| { type: 'tableStatementExecuted' }
	| { type: 'tableCreateError'; message: string };

export interface MysqlTableSort { column: string; direction: 'asc' | 'desc' }
export interface MysqlTableFilter { column: string; value: string }
export interface MysqlColumnInfo { name: string; dataType: string; boolean: boolean; nullable: boolean; primaryKey: boolean; autoIncrement: boolean; hasDefault: boolean; editable: boolean }
export interface MysqlPreviewRow { rowId: string; values: Array<string | null>; editValues: Array<string | null> }

export type MysqlTablePreviewExtensionMessage =
	| { type: 'initialize'; database: string; table: string }
	| { type: 'tableLoading' }
	| { type: 'tableData'; columns: string[]; columnInfo: MysqlColumnInfo[]; rows: MysqlPreviewRow[]; canEdit: boolean; editDisabledReason?: string; page: number; pageSize: number; totalRows: number; totalPages: number; sort?: MysqlTableSort; filters: MysqlTableFilter[] }
	| { type: 'tableError'; message: string }
	| { type: 'rowUpdatePreview'; confirmationId: string; sql: string }
	| { type: 'rowUpdateError'; message: string }
	| { type: 'rowUpdated' }
	| { type: 'rowInsertPreview'; confirmationId: string; sql: string }
	| { type: 'rowInsertError'; message: string }
	| { type: 'rowInserted' };