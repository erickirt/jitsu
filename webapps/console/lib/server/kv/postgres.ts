import type { Pool } from "pg";
import { getErrorMessage } from "juava";
import { getServerLog } from "../log";
import type { KvStore, SetOpts } from "./types";

const log = getServerLog("kv");

const DEFAULT_TABLE = "newjitsu.kv";
const DEFAULT_SCAN_LIMIT = 1000;

const schemaSql = (table: string) => `
  CREATE TABLE IF NOT EXISTS ${table} (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    expires_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS ${indexName(table, "expires")} ON ${table} (expires_at);
  -- text_pattern_ops makes LIKE 'prefix%' an index scan (default text ops
  -- doesn't, unless the DB is in C locale).
  CREATE INDEX IF NOT EXISTS ${indexName(table, "prefix")} ON ${table} (key text_pattern_ops);
`;

function indexName(table: string, suffix: string): string {
  // Strip schema qualifier and use _ separator — PG identifiers can't have dots.
  const bare = table.split(".").pop()!;
  return `${bare}_${suffix}_idx`;
}

function expireDate(ttlMs?: number): Date | null {
  if (!ttlMs || ttlMs <= 0) return null;
  return new Date(Date.now() + ttlMs);
}

// Probabilistic GC: roughly 5% of writes/reads fire-and-forget a bulk delete
// of expired rows. Keeps the table from growing unboundedly without needing
// a cron. The "lazy on read" filter still hides expired rows in the meantime.
function maybeGc(pgPool: Pool, table: string) {
  if (Math.random() < 0.05) {
    pgPool.query(`DELETE FROM ${table} WHERE expires_at IS NOT NULL AND expires_at <= NOW()`).catch(e => {
      log.atWarn().log(`KV GC sweep failed: ${getErrorMessage(e)}`);
    });
  }
}

export class PgKvStore implements KvStore {
  private initialized = false;

  constructor(
    private readonly pool: Pool,
    private readonly table: string = DEFAULT_TABLE
  ) {}

  private async initOnce() {
    if (this.initialized) return;
    try {
      await this.pool.query(schemaSql(this.table));
    } catch (e) {
      log.atWarn().log(`KV init failed (${this.table}): ${getErrorMessage(e)}`);
    }
    this.initialized = true;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    await this.initOnce();
    maybeGc(this.pool, this.table);
    const r = await this.pool.query<{ value: T; expires_at: Date | null }>({
      text: `SELECT value, expires_at FROM ${this.table} WHERE key = $1`,
      values: [key],
    });
    if (r.rows.length === 0) return undefined;
    const { value, expires_at } = r.rows[0];
    if (expires_at && expires_at.getTime() <= Date.now()) {
      // Expired-on-read: drop it. Don't block the response on the delete.
      this.pool
        .query({ text: `DELETE FROM ${this.table} WHERE key = $1`, values: [key] })
        .catch(() => undefined);
      return undefined;
    }
    return value;
  }

  async set(key: string, value: unknown, opts: SetOpts = {}): Promise<boolean> {
    await this.initOnce();
    maybeGc(this.pool, this.table);
    const expiresAt = expireDate(opts.ttlMs);
    if (opts.ifNotExists) {
      // Insert or overwrite *only if the existing row is expired*. The
      // ON CONFLICT WHERE filter is what makes this atomic: PG evaluates the
      // predicate against the conflicting row before deciding to UPDATE,
      // so two concurrent ifNotExists callers can't both succeed.
      const r = await this.pool.query({
        text: `INSERT INTO ${this.table} (key, value, expires_at) VALUES ($1, $2::jsonb, $3)
               ON CONFLICT (key) DO UPDATE
                 SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
                 WHERE ${this.table}.expires_at IS NOT NULL AND ${this.table}.expires_at <= NOW()`,
        values: [key, JSON.stringify(value), expiresAt],
      });
      return (r.rowCount ?? 0) > 0;
    }
    await this.pool.query({
      text: `INSERT INTO ${this.table} (key, value, expires_at) VALUES ($1, $2::jsonb, $3)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
      values: [key, JSON.stringify(value), expiresAt],
    });
    return true;
  }

  async del(key: string): Promise<boolean> {
    await this.initOnce();
    const r = await this.pool.query({
      text: `DELETE FROM ${this.table} WHERE key = $1`,
      values: [key],
    });
    return (r.rowCount ?? 0) > 0;
  }

  async getDel<T = unknown>(key: string): Promise<T | undefined> {
    await this.initOnce();
    // Atomic: a single DELETE ... RETURNING. Two concurrent getDel calls on
    // the same key — at most one sees a row. This is the property OAuth
    // code consumption relies on.
    const r = await this.pool.query<{ value: T; expires_at: Date | null }>({
      text: `DELETE FROM ${this.table} WHERE key = $1 RETURNING value, expires_at`,
      values: [key],
    });
    if (r.rows.length === 0) return undefined;
    const { value, expires_at } = r.rows[0];
    if (expires_at && expires_at.getTime() <= Date.now()) {
      // We deleted an already-expired row. Don't surface its value.
      return undefined;
    }
    return value;
  }

  async scanByPrefix<T = unknown>(
    prefix: string,
    opts: { limit?: number } = {}
  ): Promise<Array<{ key: string; value: T }>> {
    await this.initOnce();
    maybeGc(this.pool, this.table);
    const limit = Math.min(opts.limit ?? DEFAULT_SCAN_LIMIT, DEFAULT_SCAN_LIMIT);
    // Escape LIKE metacharacters in the user prefix so a stray `%` or `_`
    // doesn't blow up the match window.
    const escaped = prefix.replace(/([\\%_])/g, "\\$1");
    const r = await this.pool.query<{ key: string; value: T }>({
      text: `SELECT key, value FROM ${this.table}
             WHERE key LIKE $1 ESCAPE '\\'
               AND (expires_at IS NULL OR expires_at > NOW())
             ORDER BY key ASC
             LIMIT $2`,
      values: [escaped + "%", limit],
    });
    return r.rows;
  }
}
