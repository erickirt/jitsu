import { createClient } from "@clickhouse/client";
import { Client, types } from "pg";
import Cursor from "pg-cursor";
import { z } from "zod";
import { ModelDefinition, PreviewResult, WarehouseColumn, supportsWarehouseReader } from "./schema";
import { compileModel, CompositeCursor, decodeDelete, keyCountColumn, validateColumns, validateQuery } from "./sql";

export type { CompositeCursor } from "./sql";
export type { ModelDefinition, WarehouseColumn, PreviewResult } from "./schema";
export { validateQuery, validateColumns } from "./sql";

export interface SourceRecord {
  row: Record<string, unknown>;
  deleted: boolean;
  checkpoint?: CompositeCursor;
}
export interface WarehouseReader {
  columns(query: string, signal?: AbortSignal): Promise<WarehouseColumn[]>;
  preview(query: string, signal?: AbortSignal): Promise<PreviewResult>;
  stream(model: ModelDefinition, after?: CompositeCursor, signal?: AbortSignal): AsyncIterable<SourceRecord>;
  close(): Promise<void>;
}

const pgCredentials = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(5432),
  database: z.string().min(1),
  username: z.string().default("postgres"),
  password: z.string().optional(),
  sslMode: z.enum(["disable", "require", "verify-ca", "verify-full"]).default("require"),
  sslServerCA: z.string().optional(),
  sslClientCert: z.string().optional(),
  sslClientKey: z.string().optional(),
  defaultSchema: z.string().default("public"),
});
const chCredentials = z.object({
  protocol: z.enum(["http", "https"]),
  hosts: z.array(z.string().min(1)).min(1),
  database: z.string().default("default"),
  username: z.string().default("default"),
  password: z.string(),
});
const losslessTypes = {
  getTypeParser(oid: number, format?: string) {
    if ([20, 1700, 1082, 1114, 1184].includes(oid)) return (value: string) => value;
    return types.getTypeParser(oid, format as "text");
  },
};

function decodeRecord(model: ModelDefinition, record: Record<string, unknown>): SourceRecord {
  if (String(record[keyCountColumn]) !== "1") throw new Error("Model query contains duplicate primary keys");
  delete record[keyCountColumn];
  const key = model.primaryKey.map(name => {
    const value = record[name];
    if (value === null || value === undefined || !["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`Primary-key column '${name}' must contain non-null scalar values`);
    }
    return String(value);
  });
  let checkpoint: CompositeCursor | undefined;
  if (model.cursor) {
    const value = record[model.cursor.column];
    if (value === null || value === undefined || !["string", "number"].includes(typeof value)) {
      throw new Error("Cursor column must contain non-null scalar values");
    }
    checkpoint = { value: String(value), primaryKeyValues: key };
  }
  return { row: record, deleted: model.deleteColumn ? decodeDelete(record[model.deleteColumn]) : false, checkpoint };
}

function boundedPreview(columns: WarehouseColumn[], rows: Record<string, unknown>[]): PreviewResult {
  const shown = rows.slice(0, 100);
  if (Buffer.byteLength(JSON.stringify(shown)) > 2_000_000)
    throw new Error("Preview exceeds 2 MB; select fewer or smaller columns");
  return { columns, rows: shown, truncated: rows.length > 100 };
}

export function createWarehouseReader(config: Record<string, any>): WarehouseReader {
  if (!supportsWarehouseReader(config)) throw new Error("This warehouse connection is not supported for models yet");
  return config.destinationType === "postgres"
    ? postgresReader(pgCredentials.parse(config))
    : clickhouseReader(chCredentials.parse(config));
}

function postgresReader(config: z.infer<typeof pgCredentials>): WarehouseReader {
  const clients = new Set<Client>();
  let closed = false;
  async function connect(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (closed) throw new Error("Reader is closed");
    const client = new Client({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl:
        config.sslMode === "disable"
          ? false
          : {
              rejectUnauthorized: config.sslMode !== "require",
              ca: config.sslServerCA,
              cert: config.sslClientCert,
              key: config.sslClientKey,
              ...(config.sslMode === "verify-ca" ? { checkServerIdentity: () => undefined } : {}),
            },
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
      types: losslessTypes,
      options: "-c default_transaction_read_only=on -c timezone=UTC -c standard_conforming_strings=on",
    });
    clients.add(client);
    // Terminating our dedicated connection cancels an active server query, including
    // an in-flight cursor read. Never cancel a pooled connection owned by another run.
    const abort = () => {
      void client.end().catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    client.on("error", () => {}); // active query promises still reject
    const release = async () => {
      signal?.removeEventListener("abort", abort);
      clients.delete(client);
      await client.end().catch(() => {});
    };
    try {
      await client.connect();
      signal?.throwIfAborted();
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SELECT set_config('search_path', quote_ident($1), true)", [config.defaultSchema]);
      return { client, release };
    } catch (e) {
      await release();
      throw e;
    }
  }
  async function probe(client: Client, query: string) {
    const result = await client.query(`SELECT * FROM (${query}\n) AS model LIMIT 0`);
    return result.fields.map(f => ({ name: f.name, type: String(f.dataTypeID) }));
  }
  return {
    async columns(query, signal) {
      const sql = validateQuery(query, "postgres");
      const { client, release } = await connect(signal);
      try {
        return await probe(client, sql);
      } finally {
        await release();
      }
    },
    async preview(query, signal) {
      const sql = validateQuery(query, "postgres");
      const { client, release } = await connect(signal);
      try {
        const columns = await probe(client, sql);
        const cursor = client.query(
          new Cursor(`SELECT * FROM (${sql}\n) AS model LIMIT 101`, [], { types: losslessTypes })
        );
        const rows: Record<string, unknown>[] = [];
        while (true) {
          signal?.throwIfAborted();
          const batch = await cursor.read(10);
          if (!batch.length) return boundedPreview(columns, rows);
          rows.push(...batch);
          boundedPreview(columns, rows);
        }
      } finally {
        await release();
      }
    },
    async *stream(input, after, signal) {
      const model = ModelDefinition.parse(input);
      const sql = validateQuery(model.query, "postgres");
      const { client, release } = await connect(signal);
      try {
        const columns = await probe(client, sql);
        const compiled = compileModel(model, "postgres", columns, after);
        const cursor = client.query(new Cursor(compiled.query, compiled.values, { types: losslessTypes }));
        while (true) {
          signal?.throwIfAborted();
          const rows = await cursor.read(model.pageSize);
          if (!rows.length) break;
          for (const row of rows) {
            signal?.throwIfAborted();
            yield decodeRecord(model, row);
          }
        }
      } finally {
        // This dedicated connection owns the transaction and portal. Closing it
        // releases both; cursor.close() would wait forever after a socket abort.
        await release();
      }
    },
    async close() {
      closed = true;
      await Promise.all([...clients].map(c => c.end().catch(() => {})));
      clients.clear();
    },
  };
}

function clickhouseReader(config: z.infer<typeof chCredentials>): WarehouseReader {
  const host = config.hosts[0];
  // Match the destination's host[:port] contract; reject URL params/userinfo that
  // could override readonly settings or credentials in the ClickHouse client.
  const url = new URL(`${config.protocol}://${host}`);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Expected a ClickHouse host[:port]");
  // URL normalizes explicit :443/:80 to an empty port; those proxies must not
  // silently move to ClickHouse's native HTTP(S) defaults.
  if (!url.port && !/:\d+\/?$/.test(host.trim())) url.port = config.protocol === "https" ? "8443" : "8123";
  const client = createClient({
    url: url.toString(),
    username: config.username,
    password: config.password,
    database: config.database,
    request_timeout: 30_000,
    max_open_connections: 2,
    clickhouse_settings: {
      readonly: "1",
      max_execution_time: 30,
      max_memory_usage: "268435456",
      output_format_json_quote_64bit_integers: 1,
      output_format_json_quote_decimals: 1,
    },
  });
  async function columns(query: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const result = await client.query({
      query: `SELECT * FROM (${query}\n) AS model LIMIT 0`,
      format: "JSON",
      abort_signal: signal,
    });
    try {
      const meta = (await result.json()).meta;
      if (!meta) throw new Error("Warehouse did not return column metadata");
      return meta;
    } finally {
      result.close();
    }
  }
  return {
    columns(query, signal) {
      return columns(validateQuery(query, "clickhouse"), signal);
    },
    async preview(query, signal) {
      const sql = validateQuery(query, "clickhouse");
      const cols = await columns(sql, signal);
      signal?.throwIfAborted();
      const result = await client.query({
        query: `SELECT * FROM (${sql}\n) AS model LIMIT 101`,
        format: "JSONEachRow",
        abort_signal: signal,
        clickhouse_settings: { max_result_bytes: "2000000", result_overflow_mode: "throw" },
      });
      try {
        const rows: Record<string, unknown>[] = [];
        for await (const chunk of result.stream<Record<string, unknown>>()) {
          for (const item of chunk) {
            rows.push(item.json());
            boundedPreview(cols, rows);
          }
        }
        return boundedPreview(cols, rows);
      } finally {
        result.close();
      }
    },
    async *stream(input, after, signal) {
      const model = ModelDefinition.parse(input);
      const sql = validateQuery(model.query, "clickhouse");
      const cols = await columns(sql, signal);
      const compiled = compileModel(model, "clickhouse", cols, after);
      signal?.throwIfAborted();
      const result = await client.query({
        query: compiled.query,
        query_params: compiled.queryParams,
        format: "JSONEachRow",
        abort_signal: signal,
        clickhouse_settings: { max_block_size: String(model.pageSize) },
      });
      try {
        for await (const chunk of result.stream<Record<string, unknown>>()) {
          for (const item of chunk) {
            signal?.throwIfAborted();
            yield decodeRecord(model, item.json());
          }
        }
      } finally {
        result.close();
      }
    },
    close() {
      return client.close();
    },
  };
}
