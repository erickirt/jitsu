# Warehouse query readers

`createWarehouseReader(config)` supplies database I/O and a pure `reader.sql`
(`WarehouseSqlDialect`) for `validateQuery`, `validateColumns`, and `compileModel`.
Use `getWarehouseSqlDialect(destinationType)` when validating without credentials
or a client. Composition keeps SQL policy independently testable and avoids
putting execution methods on a SQL-only consumer.

- `postgres.ts`: PostgreSQL connections, exact scalar decoding, and SQL rules.
- `clickhouse.ts`: ClickHouse connections, result formats, and SQL rules.
- `sql.ts`: shared read-only AST checks, delimiter scanning, column invariants,
  and checkpoint/duplicate-key query construction; no warehouse-name branches.
- `reader.ts`: shared row decoding and preview bounds.
- `types.ts`: reader, dialect, and checkpoint contracts.

Each warehouse owns parsing, literal/comment rules, identifier quoting, cursor
types, parameter binding, and timestamp lookback syntax. New readers implement
`WarehouseReader` and provide a `WarehouseSqlDialect`; common planning can be
reused through `createSqlDialect`.

PostgreSQL `losslessTypes` preserves bigint, numeric, date, and timestamp text in
both direct queries and cursors. Exact values matter for stable keys, checkpoint
resumption, and destination payloads; JavaScript numbers and dates can lose
precision or change timezone interpretation.

ClickHouse currently accepts the portable SELECT subset recognized by the MySQL
grammar: [node-sql-parser's supported dialects](https://github.com/taozhi8833998/node-sql-parser#supported-database-sql-syntax)
do not include ClickHouse. This is a compatibility limit, not full ClickHouse SQL
support. A native parser can be evaluated separately. Never execute an unparsed
fallback. Parser checks are defense in depth; database read-only settings and
least-privilege warehouse credentials remain necessary.
