const SCHEMA_VERSION = 4;
const CONTENT_FILTER_SCHEMA_VERSION = 3;

const REQUIRED_CONTENT_FILTER_SCHEMA = {
  content_filters: {
    sql: [
      'CREATE TABLE content_filters (',
      'id INTEGER PRIMARY KEY AUTOINCREMENT,',
      'name TEXT UNIQUE NOT NULL,',
      'patterns TEXT NOT NULL,',
      "input_action TEXT CHECK(input_action IN ('block', 'mask') OR input_action IS NULL),",
      "output_action TEXT CHECK(output_action = 'mask' OR output_action IS NULL),",
      'is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0, 1)),',
      'is_global INTEGER NOT NULL DEFAULT 0 CHECK(is_global IN (0, 1)),',
      'created_at TEXT NOT NULL,',
      'updated_at TEXT NOT NULL,',
      'CHECK(input_action IS NOT NULL OR output_action IS NOT NULL)',
      ')'
    ].join('\n'),
    columns: [
      { name: 'id', type: 'INTEGER', is_not_null: 0, default_value: null, pk: 1 },
      { name: 'name', type: 'TEXT', is_not_null: 1, default_value: null, pk: 0 },
      { name: 'patterns', type: 'TEXT', is_not_null: 1, default_value: null, pk: 0 },
      { name: 'input_action', type: 'TEXT', is_not_null: 0, default_value: null, pk: 0 },
      { name: 'output_action', type: 'TEXT', is_not_null: 0, default_value: null, pk: 0 },
      { name: 'is_active', type: 'INTEGER', is_not_null: 1, default_value: '0', pk: 0 },
      { name: 'is_global', type: 'INTEGER', is_not_null: 1, default_value: '0', pk: 0 },
      { name: 'created_at', type: 'TEXT', is_not_null: 1, default_value: null, pk: 0 },
      { name: 'updated_at', type: 'TEXT', is_not_null: 1, default_value: null, pk: 0 }
    ],
    uniqueColumns: [['name']],
    foreignKeys: []
  },
  content_filter_models: {
    sql: [
      'CREATE TABLE content_filter_models (',
      'filter_id INTEGER NOT NULL,',
      'model_id INTEGER NOT NULL,',
      'PRIMARY KEY(filter_id, model_id),',
      'FOREIGN KEY(filter_id) REFERENCES content_filters(id) ON DELETE CASCADE,',
      'FOREIGN KEY(model_id) REFERENCES models(id) ON DELETE CASCADE',
      ')'
    ].join('\n'),
    columns: [
      { name: 'filter_id', type: 'INTEGER', is_not_null: 1, default_value: null, pk: 1 },
      { name: 'model_id', type: 'INTEGER', is_not_null: 1, default_value: null, pk: 2 }
    ],
    uniqueColumns: [['filter_id', 'model_id']],
    foreignKeys: [
      {
        from_column: 'filter_id', parent_table: 'content_filters', to_column: 'id',
        on_delete: 'CASCADE'
      },
      {
        from_column: 'model_id', parent_table: 'models', to_column: 'id',
        on_delete: 'CASCADE'
      }
    ]
  }
};

const REQUIRED_CONTENT_FILTER_MODEL_INDEX = {
  name: 'idx_content_filter_models_model_id',
  table: 'content_filter_models',
  sql: 'CREATE INDEX idx_content_filter_models_model_id ON content_filter_models(model_id)',
  columns: ['model_id']
};

function normalizeSchemaSql(sql) {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),=])\s*/g, '$1')
    .trim();
}

function assertContentFilterSchema(database) {
  const tableInfo = database.prepare(
    'SELECT name, type, "notnull" AS is_not_null, dflt_value AS default_value, pk FROM pragma_table_info(?) ORDER BY cid'
  );
  const uniqueIndexes = database.prepare(
    'SELECT name FROM pragma_index_list(?) WHERE "unique" = 1 ORDER BY name'
  ).pluck();
  const indexColumns = database.prepare(
    'SELECT name FROM pragma_index_info(?) ORDER BY seqno'
  ).pluck();
  const foreignKeys = database.prepare(
    'SELECT "from" AS from_column, "table" AS parent_table, "to" AS to_column, on_delete FROM pragma_foreign_key_list(?) ORDER BY from_column'
  );
  const schemaSql = database.prepare(
    'SELECT sql FROM sqlite_master WHERE type = ? AND name = ?'
  ).pluck();

  for (const [table, expected] of Object.entries(REQUIRED_CONTENT_FILTER_SCHEMA)) {
    const actualSql = schemaSql.get('table', table);
    const actualUniqueColumns = uniqueIndexes.all(table)
      .map((index) => indexColumns.all(index))
      .sort((left, right) => left.join('\0').localeCompare(right.join('\0')));
    const matches = actualSql
      && normalizeSchemaSql(actualSql) === normalizeSchemaSql(expected.sql)
      && JSON.stringify(tableInfo.all(table)) === JSON.stringify(expected.columns)
      && JSON.stringify(actualUniqueColumns) === JSON.stringify(expected.uniqueColumns)
      && JSON.stringify(foreignKeys.all(table)) === JSON.stringify(expected.foreignKeys);

    if (!matches) {
      throw new Error('Database table ' + table + ' does not match required schema');
    }
  }

  const expectedIndex = REQUIRED_CONTENT_FILTER_MODEL_INDEX;
  const index = database.prepare(
    'SELECT "unique" AS is_unique, origin, partial FROM pragma_index_list(?) WHERE name = ?'
  ).get(expectedIndex.table, expectedIndex.name);
  const actualIndexSql = schemaSql.get('index', expectedIndex.name);
  const matches = index
    && actualIndexSql
    && normalizeSchemaSql(actualIndexSql) === normalizeSchemaSql(expectedIndex.sql)
    && index.is_unique === 0
    && index.origin === 'c'
    && index.partial === 0
    && JSON.stringify(indexColumns.all(expectedIndex.name)) === JSON.stringify(expectedIndex.columns);
  if (!matches) {
    throw new Error('Database index ' + expectedIndex.name + ' does not match required schema');
  }
}

function assertContentFilterSchemaAbsent(database) {
  const existing = database.prepare(
    'SELECT 1 FROM sqlite_master WHERE name COLLATE NOCASE IN (?, ?, ?) LIMIT 1'
  ).get(
    'content_filters',
    'content_filter_models',
    REQUIRED_CONTENT_FILTER_MODEL_INDEX.name
  );
  if (existing) {
    throw new Error('Database contains content filter schema objects before schema version ' + CONTENT_FILTER_SCHEMA_VERSION);
  }
}

module.exports = {
  SCHEMA_VERSION,
  CONTENT_FILTER_SCHEMA_VERSION,
  assertContentFilterSchema,
  assertContentFilterSchemaAbsent
};
