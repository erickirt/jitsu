import { randomUUID } from "node:crypto";
import type { EventStore, EventId, StreamId } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { KeyValueTable } from "../kv";

// Per-event row stored in the KV table.
type StoredEvent = { streamId: StreamId; message: JSONRPCMessage; createdAt: number };

const TTL_MS = 60 * 60 * 1000;

// MCP SDK EventStore backed by the console's Postgres KV. Resumability only
// matters within a session, so 1h TTL is plenty — anything older than that
// won't be replayed by any reasonable client.
//
// Constructor takes its KeyValueTable directly (DI) so the class is trivially
// testable with an in-memory fake.
export class KvEventStore implements EventStore {
  constructor(private readonly table: KeyValueTable) {}

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const eventId = `${streamId}:${randomUUID()}`;
    const row: StoredEvent = { streamId, message, createdAt: Date.now() };
    await this.table.put(eventId, row, { ttlMs: TTL_MS });
    return eventId;
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    const row = (await this.table.get(eventId)) as StoredEvent | undefined;
    return row?.streamId;
  }

  // SDK contract: replay every event with ID > lastEventId belonging to the
  // same stream, in order. Return the streamId so the SDK can route the
  // resumed connection.
  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> }
  ): Promise<StreamId> {
    const last = (await this.table.get(lastEventId)) as StoredEvent | undefined;
    if (!last) {
      // Unknown lastEventId — nothing to replay. Return empty streamId so the
      // SDK starts a fresh stream rather than crashing.
      return "";
    }
    const all = await this.table.list();
    const sameStream = all
      .map(({ id, obj }) => ({ id, obj: obj as StoredEvent }))
      .filter(e => e.obj.streamId === last.streamId && e.obj.createdAt > last.createdAt)
      .sort((a, b) => a.obj.createdAt - b.obj.createdAt);
    for (const e of sameStream) {
      await send(e.id, e.obj.message);
    }
    return last.streamId;
  }
}
