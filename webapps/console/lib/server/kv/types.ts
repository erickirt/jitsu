/**
 * Generic key-value store with TTL. Mirrors the shape of the EE API store
 * (webapps/ee-api/lib/store.ts) but lives in console so console doesn't take
 * a cross-app dep on ee-api. Promote to a shared package later if a third
 * caller appears.
 */

export interface KeyValueTable {
  listKeys(keyPattern?: string): Promise<string[]>;
  list(keyPattern?: string): Promise<{ id: string; obj: any }[]>;
  get(key: string): Promise<any | undefined>;
  put(key: string, obj: any, opts?: { ttlMs?: number }): Promise<void>;
  del(key: string): Promise<void>;
  clear(): Promise<number>;
}

export interface KeyValueStore {
  getTable(tableName: string): KeyValueTable;
}
