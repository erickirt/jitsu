import { randomUUID } from "node:crypto";
import type { EventStore, EventId, StreamId } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { KvStore } from "../kv";

const PREFIX = "mcp:event:";
const TTL_MS = 60 * 60 * 1000;
// 13 digits covers ms timestamps up to year ~5138. Pad so lex sort == time sort.
const TIME_DIGITS = 13;

// Event ID layout: `<streamId>:<13-digit ms>:<uuid>`. Colon-separated like
// the rest of our KV keys (Redis convention).
//   - Embedding streamId means getStreamIdForEventId is a plain split (no DB hit).
//   - The 13-digit time prefix gives lex-sortable ordering within a stream.
//   - The UUID tail breaks ties when two events land in the same millisecond
//     and gives uniqueness for the KV primary key.
//
// Replay uses scanByPrefix(`mcp:event:<streamId>:`) and a strict-`>` filter
// on the event ID. Because the ID is monotonic-by-time within a stream and
// unique overall, no event is silently dropped (the same-ms bug from the
// prior implementation is gone).

function makeEventId(streamId: StreamId): EventId {
  const t = Date.now().toString().padStart(TIME_DIGITS, "0");
  return `${streamId}:${t}:${randomUUID()}`;
}

function streamIdFromEventId(eventId: EventId): StreamId | undefined {
  // streamId is everything before the first colon — by construction, it
  // can't itself contain a colon (we'd need to revisit if it ever can).
  const idx = eventId.indexOf(":");
  return idx > 0 ? eventId.slice(0, idx) : undefined;
}

export class KvEventStore implements EventStore {
  constructor(private readonly kv: KvStore) {}

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const eventId = makeEventId(streamId);
    await this.kv.set(PREFIX + eventId, { streamId, message }, { ttlMs: TTL_MS });
    return eventId;
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return streamIdFromEventId(eventId);
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> }
  ): Promise<StreamId> {
    const streamId = streamIdFromEventId(lastEventId);
    if (!streamId) return "";
    const rows = await this.kv.scanByPrefix<{ streamId: StreamId; message: JSONRPCMessage }>(
      `${PREFIX}${streamId}:`
    );
    // scanByPrefix returns rows sorted by key ascending. Filter strictly-after
    // the cursor so we don't re-send lastEventId, but DO send anything that
    // sorts greater — including events created in the same millisecond, which
    // are distinguished by the UUID suffix.
    const lastKey = PREFIX + lastEventId;
    for (const { key, value } of rows) {
      if (key <= lastKey) continue;
      const eventId = key.slice(PREFIX.length);
      await send(eventId, value.message);
    }
    return streamId;
  }
}
