import type { Pool } from "pg";
import { assertDefined, getErrorMessage } from "juava";
import { getServerLog } from "../log";
import type { KeyValueStore, KeyValueTable } from "./types";

const log = getServerLog("kv");

const schemaSql = (table: string) => `
  CREATE TABLE IF NOT EXISTS ${table}
  (
    id TEXT NOT NULL,
    namespace TEXT NOT NULL,
    obj JSONB NOT NULL default '{}'::jsonb,
    expire TIMESTAMP WITH TIME ZONE,
    primary key (id, namespace)
  );
`;

function expire(ttlMs: number): Date {
  return new Date(Date.now() + ttlMs);
}

function deleteQuery(table: string, namespace: string, key: string) {
  return {
    text: `DELETE FROM ${table} WHERE namespace = $1 AND id = $2`,
    values: [namespace, key],
  };
}

// Probabilistic GC: fire-and-forget DELETE of expired rows on ~10% of calls.
// Same pattern as the ee-api impl. Keeps the table from accumulating
// abandoned-flow OAuth codes or expired MCP event rows without a cron.
function maybeDeleteExpiredObjects(pgPool: Pool, table: string) {
  if (Math.random() < 0.1) {
    pgPool.query(`DELETE FROM ${table} WHERE expire <= NOW()`).catch(e => {
      log.atWarn().log(`Failed to delete expired KV objects: ${getErrorMessage(e)}`);
    });
  }
}

export function getPostgresStore(pgPool: Pool, opts: { tableName?: string } = {}): KeyValueStore {
  // Fully qualify the table — the console pg pool runs through pgbouncer
  // (transaction mode), so search_path can't be set per session. Default to
  // the same `newjitsu` schema Prisma uses for everything else.
  const table = opts?.tableName || `newjitsu.kvstore`;
  let initialized = false;

  const initIfNeeded = async () => {
    if (initialized) return;
    try {
      await pgPool.query(schemaSql(table));
    } catch (e: any) {
      log.atWarn().log(`Failed to initialize KV store table ${table}: ${getErrorMessage(e)}`);
    }
    initialized = true;
  };

  return {
    getTable(namespace: string): KeyValueTable {
      return {
        async clear() {
          const result = await pgPool.query({
            text: `DELETE FROM ${table} WHERE namespace = $1`,
            values: [namespace],
          });
          return result.rowCount || 0;
        },

        async list(keyPattern?: string) {
          await initIfNeeded();
          maybeDeleteExpiredObjects(pgPool, table);
          assertDefined(!keyPattern, "keyPattern is not supported yet");
          const result = await pgPool.query({
            text: `SELECT id, obj FROM ${table} WHERE namespace = $1 AND (expire IS NULL OR expire > NOW())`,
            values: [namespace],
          });
          return result.rows.map(({ id, obj }) => ({ id: id as string, obj }));
        },

        async listKeys(keyPattern?: string) {
          await initIfNeeded();
          maybeDeleteExpiredObjects(pgPool, table);
          assertDefined(!keyPattern, "keyPattern is not supported yet");
          const result = await pgPool.query({
            text: `SELECT id FROM ${table} WHERE namespace = $1 AND (expire IS NULL OR expire > NOW())`,
            values: [namespace],
          });
          return result.rows.map(({ id }) => id as string);
        },

        async del(key: string) {
          await initIfNeeded();
          maybeDeleteExpiredObjects(pgPool, table);
          await pgPool.query(deleteQuery(table, namespace, key));
        },

        async get(key: string) {
          await initIfNeeded();
          maybeDeleteExpiredObjects(pgPool, table);
          const result = await pgPool.query({
            text: `SELECT obj, expire FROM ${table} WHERE namespace = $1 AND id = $2`,
            values: [namespace, key],
          });
          if (result.rows.length === 0) return undefined;
          const { expire: exp, obj } = result.rows[0];
          if (exp && Date.now() >= exp.getTime()) {
            // Expired-on-read: delete and pretend it was never there.
            await pgPool.query(deleteQuery(table, namespace, key));
            return undefined;
          }
          return obj;
        },

        async put(key: string, obj: any, putOpts: { ttlMs?: number } = {}) {
          await initIfNeeded();
          maybeDeleteExpiredObjects(pgPool, table);
          const upsertQuery = `
            INSERT INTO ${table} (id, namespace, obj, expire)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (id, namespace) DO UPDATE SET obj = $3, expire = $4
          `;
          await pgPool.query({
            text: upsertQuery,
            values: [key, namespace, obj, putOpts.ttlMs ? expire(putOpts.ttlMs) : null],
          });
        },
      };
    },
  };
}
