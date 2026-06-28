import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SessionUser } from "../lib/schema";

// Partial-mock lib/api so verifyAccess is a no-op (it otherwise hits the db singleton);
// keep every other export intact for transitive importers.
vi.mock("../lib/api", async importOriginal => ({
  ...(await importOriginal<any>()),
  verifyAccess: vi.fn(async () => undefined),
}));

import { EventsLogService } from "../lib/server/events-log-service";

const user: SessionUser = {
  internalId: "user-1",
  externalUsername: "u1",
  externalId: "u1",
  loginProvider: "mcp",
  email: "u1@example.com",
  name: "u1",
  authType: "mcp",
  tokenId: "tok-1",
};

function makeClickhouse(rows: any[] = []) {
  const query = vi.fn(async (_params: any) => ({ json: vi.fn(async () => rows) }));
  return { clickhouse: { query } as any, query };
}

function makePrisma(overrides: any = {}) {
  return {
    configurationObject: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      ...overrides.configurationObject,
    },
    configurationObjectLink: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      ...overrides.configurationObjectLink,
    },
    profileBuilder: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      ...overrides.profileBuilder,
    },
  } as any;
}

beforeEach(() => vi.clearAllMocks());

describe("EventsLogService", () => {
  it("rejects an unknown events-log type", async () => {
    const { clickhouse } = makeClickhouse();
    const svc = new EventsLogService({ clickhouse, prisma: makePrisma() });
    await expect(svc.queryEventsLog(user, "ws1", "bogus")).rejects.toThrow(/Unknown events-log type/);
  });

  it("rejects a source that doesn't belong to the workspace", async () => {
    const { clickhouse, query } = makeClickhouse();
    const svc = new EventsLogService({ clickhouse, prisma: makePrisma() }); // all lookups return null
    await expect(svc.queryEventsLog(user, "ws1", "incoming", { source: "foreign" })).rejects.toThrow(
      /doesn't belong to the current workspace/
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("all-sources (function) scopes to connections + destinations + profile builders via IN(...)", async () => {
    const { clickhouse, query } = makeClickhouse([]);
    const prisma = makePrisma({
      configurationObject: { findMany: vi.fn(async () => [{ id: "dst-a" }]) }, // destinations
      configurationObjectLink: { findMany: vi.fn(async () => [{ id: "link-b" }]) },
      profileBuilder: { findMany: vi.fn(async () => [{ id: "pb-c" }]) },
    });
    const svc = new EventsLogService({ clickhouse, prisma });
    await svc.queryEventsLog(user, "ws1", "function"); // no source → all sources

    expect(query).toHaveBeenCalledOnce();
    const arg = query.mock.calls[0][0];
    expect(arg.query).toContain("actorId in ({actorIds:Array(String)})");
    expect(arg.query).not.toContain("actorId = {actorId:String}");
    expect(arg.query_params.actorIds).toEqual(["link-b", "dst-a", "pb-c"]);
    // destinations are looked up with type:"destination", not all config objects
    expect(prisma.configurationObject.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws1", type: "destination", deleted: false },
      select: { id: true },
    });
  });

  it("all-sources (incoming) scopes to streams only", async () => {
    const { clickhouse, query } = makeClickhouse([]);
    const prisma = makePrisma({
      configurationObject: { findMany: vi.fn(async () => [{ id: "stream-1" }]) },
      configurationObjectLink: { findMany: vi.fn(async () => [{ id: "link-b" }]) },
      profileBuilder: { findMany: vi.fn(async () => [{ id: "pb-c" }]) },
    });
    const svc = new EventsLogService({ clickhouse, prisma });
    await svc.queryEventsLog(user, "ws1", "incoming");

    expect(query.mock.calls[0][0].query_params.actorIds).toEqual(["stream-1"]);
    expect(prisma.configurationObject.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws1", type: "stream", deleted: false },
      select: { id: true },
    });
    expect(prisma.configurationObjectLink.findMany).not.toHaveBeenCalled();
    expect(prisma.profileBuilder.findMany).not.toHaveBeenCalled();
  });

  it("a specific non-incoming source is checked against destinations, not any config object", async () => {
    const { clickhouse } = makeClickhouse([]);
    const findFirst = vi.fn(async () => null);
    const prisma = makePrisma({ configurationObject: { findFirst } });
    const svc = new EventsLogService({ clickhouse, prisma });
    await expect(svc.queryEventsLog(user, "ws1", "function", { source: "stream-x" })).rejects.toThrow(
      /doesn't belong to the current workspace/
    );
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "stream-x", workspaceId: "ws1", type: "destination" } });
  });

  it("all-sources returns [] without querying when the workspace has no actors", async () => {
    const { clickhouse, query } = makeClickhouse();
    const svc = new EventsLogService({ clickhouse, prisma: makePrisma() });
    await expect(svc.queryEventsLog(user, "ws1", "function")).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("dead-letter 'all' omits the actor filter (table is workspace-scoped)", async () => {
    const { clickhouse, query } = makeClickhouse([]);
    const svc = new EventsLogService({ clickhouse, prisma: makePrisma() });
    await svc.queryDeadLetter(user, "ws1", {}); // no source → all
    const arg = query.mock.calls[0][0];
    expect(arg.query).toContain("workspaceId = {workspaceId:String}");
    expect(arg.query).not.toContain("and actorId = {actorId:String}");
    expect(arg.query_params.workspaceId).toBe("ws1");
  });

  it("parses payload/error JSON for dead-letter rows", async () => {
    const { clickhouse } = makeClickhouse([
      {
        date: "2026-06-28 00:00:00.000",
        workspaceId: "ws1",
        actorId: "link-b",
        type: "function",
        payload: '{"a":1}',
        error: '{"e":"boom"}',
      },
    ]);
    const prisma = makePrisma({ configurationObjectLink: { findFirst: vi.fn(async () => ({ id: "link-b" })) } });
    const svc = new EventsLogService({ clickhouse, prisma });
    const rows = await svc.queryDeadLetter(user, "ws1", { source: "link-b" });
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ a: 1 });
    expect(rows[0].error).toEqual({ e: "boom" });
  });

  it("listEventSources('incoming') returns streams", async () => {
    const prisma = makePrisma({
      configurationObject: { findMany: vi.fn(async () => [{ id: "s1", config: { name: "My Site" } }]) },
    });
    const svc = new EventsLogService({ clickhouse: makeClickhouse().clickhouse, prisma });
    const sources = await svc.listEventSources(user, "ws1", "incoming");
    expect(sources).toEqual([{ id: "s1", name: "My Site", kind: "stream" }]);
  });

  it("listEventSources('dead-letter') prepends the 'all' sentinel", async () => {
    const svc = new EventsLogService({ clickhouse: makeClickhouse().clickhouse, prisma: makePrisma() });
    const sources = await svc.listEventSources(user, "ws1", "dead-letter");
    expect(sources[0]).toEqual({ id: "all", name: "All sources", kind: "all" });
  });
});
