import { describe, expect, it } from "vitest";
import { createWarehouseReader, getWarehouseSqlDialect } from "./index";
import { postgresSql, losslessTypes } from "./postgres";
import { clickhouseSql } from "./clickhouse";
import { ModelDefinition } from "./schema";

describe("warehouse-owned SQL", () => {
  it("selects pure SQL policy without credentials or a connection", async () => {
    expect(getWarehouseSqlDialect("postgres")).toBe(postgresSql);
    expect(getWarehouseSqlDialect("clickhouse")).toBe(clickhouseSql);
    expect(() => getWarehouseSqlDialect("unknown")).toThrow(/not supported/);
    const pg = createWarehouseReader({ destinationType: "postgres", host: "unused.invalid", database: "unused" });
    const ch = createWarehouseReader({
      destinationType: "clickhouse",
      protocol: "http",
      hosts: ["unused.invalid"],
      password: "",
    });
    try {
      expect(pg.sql).toBe(postgresSql);
      expect(ch.sql).toBe(clickhouseSql);
    } finally {
      await Promise.all([pg.close(), ch.close()]);
    }
  });

  it("uses only the current warehouse's cursor type vocabulary", () => {
    const model = ModelDefinition.parse({
      warehouseId: "wh",
      query: "SELECT id FROM t",
      primaryKey: ["id"],
      cursor: { column: "id", type: "number" },
    });
    expect(() => postgresSql.validateColumns(model, [{ name: "id", type: "20" }])).not.toThrow();
    expect(() => clickhouseSql.validateColumns(model, [{ name: "id", type: "Nullable(Int64)" }])).not.toThrow();
    expect(() => postgresSql.validateColumns(model, [{ name: "id", type: "Int64" }])).toThrow(/does not match/);
    expect(() => clickhouseSql.validateColumns(model, [{ name: "id", type: "20" }])).toThrow(/does not match/);
  });

  it("preserves ClickHouse literals and hash comments", () => {
    const query = "SELECT 'semi;colon' AS value; # tail;";
    expect(clickhouseSql.validateQuery(query)).toBe("SELECT 'semi;colon' AS value # tail;");
  });

  it("binds ClickHouse lookback with its own syntax and no key parameter", () => {
    const model = ModelDefinition.parse({
      warehouseId: "wh",
      query: "SELECT id, changed FROM t",
      primaryKey: ["id"],
      cursor: { column: "changed", type: "timestamp", lookbackSeconds: 60 },
    });
    const result = clickhouseSql.compileModel(
      model,
      [
        { name: "id", type: "UInt64" },
        { name: "changed", type: "DateTime64(6, 'UTC')" },
      ],
      { value: "2026-01-01 00:00:00.123456", primaryKeyValues: ["9007199254740993"] }
    );
    expect(result.queryParams).toEqual({ p0: "2026-01-01 00:00:00.123456" });
    expect(result.values).toEqual([]);
    expect(result.query).toContain("`changed` >= subtractSeconds({p0: DateTime64(6, 'UTC')}, 60)");
  });

  it("rejects unsafe ClickHouse checkpoint metadata before inserting it into SQL", () => {
    const model = ModelDefinition.parse({
      warehouseId: "wh",
      query: "SELECT id, changed FROM t",
      primaryKey: ["id"],
      cursor: { column: "changed", type: "number" },
    });
    expect(() =>
      clickhouseSql.compileModel(
        model,
        [
          { name: "id", type: "String}; DROP TABLE t; --" },
          { name: "changed", type: "Int64" },
        ],
        { value: "1", primaryKeyValues: ["key"] }
      )
    ).toThrow(/Unsupported checkpoint type/);
  });
});

describe("PostgreSQL lossless text decoding", () => {
  it.each([
    [20, "9007199254740993"],
    [1700, "12345678901234567890.12345678901234567890"],
    [1082, "2026-01-01"],
    [1114, "2026-01-01 00:00:00.123456"],
    [1184, "2026-01-01 00:00:00.123456+00"],
  ] as const)("preserves exact text for OID %i", (oid, value) => {
    expect(losslessTypes.getTypeParser(oid, "text")(value)).toBe(value);
  });
  it("keeps standard decoding for other scalar types", () => {
    expect(losslessTypes.getTypeParser(23, "text")("42")).toBe(42);
    expect(losslessTypes.getTypeParser(16, "text")("t")).toBe(true);
  });
});
