import type { PrismaClient } from "@prisma/client";
import { getErrorMessage } from "juava";
import { getServerLog } from "../log";
import type { KvStore, SetOpts } from "./types";

const log = getServerLog("kv");

// Schema is defined by the Prisma `Kv` model (prisma/schema.prisma) and
// created via `pnpm db:update-schema`. No lazy init here — at runtime we
// assume the table exists.

function expireDate(ttlMs?: number): Date | null {
  if (!ttlMs || ttlMs <= 0) return null;
  return new Date(Date.now() + ttlMs);
}

// Probabilistic GC: roughly 5% of mutating ops fire-and-forget a bulk
// delete of expired rows. Keeps the table from accumulating forever
// without needing a cron. The "lazy on read" filter still hides expired
// rows in the meantime.
function maybeGc(prisma: PrismaClient) {
  if (Math.random() < 0.05) {
    prisma.kv.deleteMany({ where: { expiresAt: { lte: new Date() } } }).catch(e => {
      log.atWarn().log(`KV GC sweep failed: ${getErrorMessage(e)}`);
    });
  }
}

export class PgKvStore implements KvStore {
  constructor(private readonly prisma: PrismaClient) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    maybeGc(this.prisma);
    const row = await this.prisma.kv.findUnique({ where: { key } });
    if (!row) return undefined;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      // Expired-on-read: drop it. Don't block the response on the delete.
      this.prisma.kv.deleteMany({ where: { key } }).catch(() => undefined);
      return undefined;
    }
    return row.value as T;
  }

  async set(key: string, value: unknown, opts: SetOpts = {}): Promise<boolean> {
    maybeGc(this.prisma);
    const expiresAt = expireDate(opts.ttlMs);
    if (opts.ifNotExists) {
      // ON CONFLICT ... WHERE ... is the atomic primitive: PG evaluates the
      // predicate against the conflicting row before deciding to UPDATE, so
      // two concurrent ifNotExists callers can't both succeed. We do allow
      // overwriting an already-expired row — that's "absent" for our purposes.
      // No Prisma client equivalent, so raw SQL.
      const rows = await this.prisma.$queryRaw<Array<{ key: string }>>`
        INSERT INTO newjitsu.kv (key, value, expires_at)
        VALUES (${key}, ${JSON.stringify(value)}::jsonb, ${expiresAt})
        ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
          WHERE newjitsu.kv.expires_at IS NOT NULL AND newjitsu.kv.expires_at <= NOW()
        RETURNING key
      `;
      return rows.length > 0;
    }
    await this.prisma.kv.upsert({
      where: { key },
      create: { key, value: value as never, expiresAt },
      update: { value: value as never, expiresAt },
    });
    return true;
  }

  async del(key: string): Promise<boolean> {
    const r = await this.prisma.kv.deleteMany({ where: { key } });
    return r.count > 0;
  }

  async getDel<T = unknown>(key: string): Promise<T | undefined> {
    // Atomic: a single DELETE ... RETURNING. Two concurrent getDel calls on
    // the same key — at most one sees a row. This is the property OAuth
    // code consumption relies on. Prisma's `delete()` doesn't compose well
    // here (throws on not-found, returns by .id only), so raw SQL.
    const rows = await this.prisma.$queryRaw<Array<{ value: T; expires_at: Date | null }>>`
      DELETE FROM newjitsu.kv WHERE key = ${key} RETURNING value, expires_at
    `;
    if (rows.length === 0) return undefined;
    const { value, expires_at } = rows[0];
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
    maybeGc(this.prisma);
    const limit = Math.min(opts.limit ?? 1000, 1000);
    const rows = await this.prisma.kv.findMany({
      where: {
        key: { startsWith: prefix },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { key: "asc" },
      take: limit,
    });
    return rows.map(r => ({ key: r.key, value: r.value as T }));
  }
}
