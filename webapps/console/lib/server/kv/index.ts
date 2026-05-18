import { getSingleton } from "juava";
import { db } from "../db";
import { PgKvStore } from "./postgres";
import type { KvStore } from "./types";

export type { KvStore, SetOpts } from "./types";
export { PgKvStore } from "./postgres";

// Console-wide KV singleton. Backed by Postgres (`newjitsu.kv`, auto-created
// on first use). Follows the same accessor-function pattern as `db.prisma()` —
// call `consoleKv()` to get the store instance.
export const consoleKv = getSingleton<KvStore>("console-kv", () => new PgKvStore(db.pgPool()));
