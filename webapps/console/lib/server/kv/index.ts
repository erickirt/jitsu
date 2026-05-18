import { getSingleton } from "juava";
import { db } from "../db";
import { getPostgresStore } from "./postgres";
import type { KeyValueStore } from "./types";

export type { KeyValueStore, KeyValueTable } from "./types";

// Console-wide KV store singleton. Lives in the same Postgres as Prisma data
// (table `public.kvstore`, auto-created on first use). Currently used by the
// MCP server for OAuth authorization codes and the MCP stateful event log.
// Follows the same accessor-function pattern as `db.prisma()` — call `consoleKv()`
// to get the store instance.
export const consoleKv = getSingleton<KeyValueStore>("console-kv", () => getPostgresStore(db.pgPool()));
