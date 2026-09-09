import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { createWarehouseReader, SourceRecord } from "@jitsu/warehouse-query";
import { ModelDefinition } from "@jitsu/warehouse-query/src/schema";
import { ConfigObjectsService } from "../../lib/server/config-objects-service";
import { previewModel } from "../../lib/server/reverse-etl-models";
import { getServerEnv } from "../../lib/server/serverEnv";
import { deps, seedWorkspace } from "./support/harness";
import { server } from "./support/msw";

const env = getServerEnv();
const pgUrl = new URL(env.DATABASE_URL);
const chUrl = new URL(env.CLICKHOUSE_URL!);
const pgConfig = {
  destinationType: "postgres",
  host: pgUrl.hostname,
  port: Number(pgUrl.port),
  database: pgUrl.pathname.slice(1),
  username: pgUrl.username,
  password: pgUrl.password,
  sslMode: "disable",
  defaultSchema: "public",
};
const chConfig = {
  destinationType: "clickhouse",
  protocol: "http",
  hosts: [chUrl.host],
  database: env.CLICKHOUSE_DATABASE,
  username: "default",
  password: "",
};
const pgReader = createWarehouseReader(pgConfig);
const chReader = createWarehouseReader(chConfig);
const definition = ModelDefinition.parse({
  warehouseId: "test",
  query: "SELECT id, changed, removed FROM retl_audience",
  primaryKey: ["id"],
  cursor: { column: "changed", type: "timestamp" },
  deleteColumn: "removed",
  pageSize: 1,
});
async function collect(rows: AsyncIterable<SourceRecord>) {
  const result: SourceRecord[] = [];
  for await (const row of rows) result.push(row);
  return result;
}

beforeAll(async () => {
  await deps().pgPool.query("CREATE TABLE public.retl_audience (id bigint, changed timestamptz, removed boolean)");
  await deps().pgPool.query(
    "INSERT INTO public.retl_audience VALUES (9007199254740993, '2026-01-01 00:00:00.123456+00', false), (9007199254740994, '2026-01-01 00:00:00.123456+00', true), (9007199254740995, '2026-01-01 00:00:00.123457+00', false)"
  );
  await deps().clickhouse.command({
    query:
      "CREATE TABLE retl_audience (id UInt64, changed DateTime64(6, 'UTC'), removed UInt8) ENGINE = MergeTree ORDER BY id",
  });
  await deps().clickhouse.command({
    query:
      "INSERT INTO retl_audience VALUES (9007199254740993, '2026-01-01 00:00:00.123456', 0), (9007199254740994, '2026-01-01 00:00:00.123456', 1), (9007199254740995, '2026-01-01 00:00:00.123457', 0)",
  });
});
afterAll(async () => {
  await pgReader.close();
  await chReader.close();
});

it.each([
  ["https", 443, ""],
  ["http", 80, ""],
  ["https", 443, "/"],
  ["http", 80, "/"],
] as const)("preserves an explicit %s port %s with suffix '%s'", async (protocol, port, suffix) => {
  server.use(
    http.post(`${protocol}://warehouse.test.local`, () =>
      HttpResponse.json({
        meta: [{ name: "id", type: "UInt8" }],
        data: [],
        rows: 0,
      })
    )
  );
  const reader = createWarehouseReader({ ...chConfig, protocol, hosts: [`warehouse.test.local:${port}${suffix}`] });
  try {
    expect(await reader.columns("SELECT 1 AS id")).toEqual([{ name: "id", type: "UInt8" }]);
  } finally {
    await reader.close();
  }
});

describe.each([
  ["Postgres", pgReader],
  ["ClickHouse", chReader],
] as const)("%s reader", (_, reader) => {
  it("preserves big integers, microseconds and cursor ties through resume", async () => {
    const rows = await collect(reader.stream(definition));
    expect(rows.map(r => r.row.id)).toEqual(["9007199254740993", "9007199254740994", "9007199254740995"]);
    expect(rows.map(r => r.deleted)).toEqual([false, true, false]);
    expect(rows[0].checkpoint!.value).toContain(".123456");
    const resumed = await collect(reader.stream(definition, rows[0].checkpoint));
    expect(resumed.map(r => r.row.id)).toEqual(["9007199254740994", "9007199254740995"]);
    const lookback = await collect(
      reader.stream({ ...definition, cursor: { ...definition.cursor!, lookbackSeconds: 60 } }, rows[1].checkpoint)
    );
    expect(lookback).toHaveLength(3);
  });
  it("rejects duplicate keys even across different cursor values", async () => {
    await expect(
      collect(reader.stream({ ...definition, query: "SELECT 1 AS id, changed, removed FROM retl_audience" }))
    ).rejects.toThrow(/duplicate primary keys/);
  });
  it("rejects null keys", async () => {
    await expect(
      collect(
        reader.stream({
          ...definition,
          query: "SELECT NULL AS id, changed, removed FROM retl_audience",
          cursor: undefined,
        })
      )
    ).rejects.toThrow();
  });
  it("cancels before sending SQL", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(reader.preview("SELECT 1 AS id", controller.signal)).rejects.toThrow();
  });
});

it("Postgres preview caps rows and does not lose precision", async () => {
  const preview = await pgReader.preview("SELECT id FROM generate_series(1, 150) AS id");
  expect(preview.rows).toHaveLength(100);
  expect(preview.truncated).toBe(true);
  expect((await pgReader.preview(definition.query)).rows[0].id).toBe("9007199254740993");
});

it("preserves PostgreSQL case folding and literal semicolons", async () => {
  const result = await pgReader.preview(
    "SELECT ID AS ID, '; -- not a comment' AS literal FROM RETL_AUDIENCE; -- tail;"
  );
  expect(result.columns.map(c => c.name)).toEqual(["id", "literal"]);
  expect(result.rows[0].literal).toBe("; -- not a comment");
});
it("Postgres enforces read-only even inside a mutating function", async () => {
  await deps().pgPool.query(
    "CREATE FUNCTION public.retl_mutate() RETURNS integer LANGUAGE sql AS 'INSERT INTO public.retl_audience VALUES (4, now(), false) RETURNING 1'"
  );
  await expect(pgReader.preview("SELECT retl_mutate() AS value")).rejects.toThrow(/read-only/);
});
it("Postgres cancels an in-flight query", async () => {
  await expect(pgReader.preview("SELECT pg_sleep(10)", AbortSignal.timeout(50))).rejects.toThrow();
});

it("ClickHouse preserves null, boolean, and decimal values", async () => {
  const result = await chReader.preview(
    "SELECT NULL AS missing, true AS enabled, toDecimal64('1234567890.123456', 6) AS amount"
  );
  expect(result.rows[0]).toEqual({ missing: null, enabled: true, amount: "1234567890.123456" });
});

it("both readers enforce the preview byte limit", async () => {
  await expect(pgReader.preview("SELECT repeat('x', 2000001) AS large")).rejects.toThrow(/2 MB/);
  await expect(chReader.preview("SELECT repeat('x', 2000001) AS large")).rejects.toThrow();
});

describe("Models service", () => {
  const service = new ConfigObjectsService({ prisma: deps().prisma });
  async function fixture() {
    const { user, workspace } = await seedWorkspace();
    await deps().prisma.workspace.update({ where: { id: workspace.id }, data: { featuresEnabled: ["reverse-etl"] } });
    const warehouse = await deps().prisma.configurationObject.create({
      data: {
        workspaceId: workspace.id,
        type: "destination",
        config: { ...pgConfig, type: "destination", name: "Warehouse" },
      },
    });
    return { user, workspace, warehouse, model: { ...definition, name: "Audience", warehouseId: warehouse.id } };
  }
  it("gates Models and denies foreign warehouse references", async () => {
    const disabled = await seedWorkspace();
    await expect(service.list(disabled.user, disabled.workspace.id, "model")).rejects.toMatchObject({ status: 403 });
    const a = await fixture();
    const b = await fixture();
    await expect(
      service.create(a.user, a.workspace.id, "model", { ...a.model, warehouseId: b.warehouse.id }, { generateId: true })
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.list(b.user, a.workspace.id, "model")).rejects.toMatchObject({ status: 403 });
  });
  it("saves with audit, checks projections, and protects referenced warehouses", async () => {
    const { user, workspace, warehouse, model } = await fixture();
    const { id } = await service.create(user, workspace.id, "model", model, { generateId: true });
    expect(await deps().prisma.auditLog.count({ where: { workspaceId: workspace.id, objectId: id } })).toBe(1);
    await expect(
      service.delete(user, workspace.id, "destination", warehouse.id, { cascade: true })
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.update(user, workspace.id, "model", id, { query: "SELECT id FROM retl_audience" })
    ).rejects.toThrow(/project/);
    await service.update(user, workspace.id, "model", id, { cursor: null, deleteColumn: null });
    expect(await service.get(user, workspace.id, "model", id)).not.toHaveProperty("cursor");
    await service.delete(user, workspace.id, "model", id);
    await expect(service.delete(user, workspace.id, "destination", warehouse.id)).resolves.toMatchObject({
      id: warehouse.id,
    });
  });
  it("does not expose warehouse exceptions from preview", async () => {
    const { workspace, warehouse } = await fixture();
    await expect(
      previewModel(deps().prisma, workspace.id, warehouse.id, "SELECT secret_customer_value FROM nonexistent")
    ).rejects.toThrow("Preview failed or exceeded its limit");
  });

  it("does not leave a live model referencing a concurrently deleted warehouse", async () => {
    const { user, workspace, warehouse, model } = await fixture();
    await Promise.allSettled([
      service.create(user, workspace.id, "model", model, { generateId: true }),
      service.delete(user, workspace.id, "destination", warehouse.id),
    ]);
    const current = await deps().prisma.configurationObject.findUniqueOrThrow({ where: { id: warehouse.id } });
    const models = await deps().prisma.configurationObject.count({
      where: { workspaceId: workspace.id, type: "model", deleted: false },
    });
    expect(current.deleted && models > 0).toBe(false);
  });

  it("denies analyst writes and incompatible changes to a model's warehouse", async () => {
    const { user, workspace, warehouse, model } = await fixture();
    const { id } = await service.create(user, workspace.id, "model", model, { generateId: true });
    await expect(
      service.update(user, workspace.id, "destination", warehouse.id, {
        ...chConfig,
        name: "Changed warehouse",
        type: "destination",
      })
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.update(user, workspace.id, "destination", warehouse.id, {
        authenticationMethod: "google-psc",
      })
    ).rejects.toMatchObject({ status: 409 });
    await deps().prisma.workspaceAccess.updateMany({
      where: { workspaceId: workspace.id, userId: user.internalId },
      data: { role: "analyst" },
    });
    await expect(service.create(user, workspace.id, "model", model, { generateId: true })).rejects.toMatchObject({
      status: 403,
    });
    await expect(service.update(user, workspace.id, "model", id, { name: "changed" })).rejects.toMatchObject({
      status: 403,
    });
    await expect(service.delete(user, workspace.id, "model", id)).rejects.toMatchObject({ status: 403 });
  });
});
