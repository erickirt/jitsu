import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SessionUser } from "../lib/schema";

// The service delegates access checks, audit logging, telemetry and sync scheduling to
// shared helpers that reach for the db.prisma() singleton. Mock those so we can unit-test
// the service's own logic (id minting, type validation, payload shaping, not-found paths)
// against a fake prisma — no database required.
// Partial mocks: keep the modules' other exports intact (they're imported transitively
// by the schema/route layer), override only what the service calls for access/audit.
vi.mock("../lib/api", async importOriginal => ({
  ...(await importOriginal<any>()),
  verifyAccess: vi.fn(async () => undefined),
  verifyAccessWithRole: vi.fn(async () => ({
    role: "owner",
    editEntities: true,
    deleteEntities: true,
    readEntities: true,
  })),
}));
vi.mock("../lib/server/audit-log", async importOriginal => ({
  ...(await importOriginal<any>()),
  configObjectAuditLog: vi.fn(async () => undefined),
}));
vi.mock("../lib/server/telemetry", async importOriginal => ({
  ...(await importOriginal<any>()),
  trackTelemetryEvent: vi.fn(async () => undefined),
  withProductAnalytics: vi.fn(async () => undefined),
}));
vi.mock("../lib/server/sync", async importOriginal => ({
  ...(await importOriginal<any>()),
  scheduleSync: vi.fn(async () => undefined),
  validateSyncSchedule: vi.fn(() => undefined),
}));

import { ConfigObjectsService } from "../lib/server/config-objects-service";

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

function makePrisma(overrides: any = {}) {
  return {
    workspace: {
      findFirst: vi.fn(async () => ({ id: "ws1", name: "WS" })),
      findMany: vi.fn(async () => []),
      ...overrides.workspace,
    },
    configurationObject: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => ({ id: data.id })),
      update: vi.fn(async () => ({})),
      ...overrides.configurationObject,
    },
    configurationObjectLink: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      ...overrides.configurationObjectLink,
    },
    userProfile: { findUnique: vi.fn(async () => ({ id: "user-1", admin: false })), ...overrides.userProfile },
    workspaceAccess: { findMany: vi.fn(async () => []), ...overrides.workspaceAccess },
  } as any;
}

beforeEach(() => vi.clearAllMocks());

describe("ConfigObjectsService", () => {
  it("rejects unknown resource types", async () => {
    const svc = new ConfigObjectsService({ prisma: makePrisma() });
    await expect(svc.list(user, "ws1", "bogus")).rejects.toThrow(/Unknown resource type/);
  });

  it("create mints an id and strips id/workspaceId from stored config", async () => {
    const prisma = makePrisma();
    const svc = new ConfigObjectsService({ prisma });
    const res = await svc.create(user, "ws1", "domain", { name: "example.com" });

    expect(prisma.configurationObject.create).toHaveBeenCalledOnce();
    const arg = prisma.configurationObject.create.mock.calls[0][0];
    expect(arg.data.type).toBe("domain");
    expect(arg.data.id).toBeTruthy();
    expect(res.id).toBe(arg.data.id);
    // stored config carries the type but not id/workspaceId (those live in columns)
    expect(arg.data.config.id).toBeUndefined();
    expect(arg.data.config.workspaceId).toBeUndefined();
    expect(arg.data.config.name).toBe("example.com");
  });

  it("create honours a caller-supplied id", async () => {
    const prisma = makePrisma();
    const svc = new ConfigObjectsService({ prisma });
    const res = await svc.create(user, "ws1", "domain", { id: "fixed-id", name: "example.com" });
    expect(res.id).toBe("fixed-id");
  });

  it("get throws 404 when the object is missing", async () => {
    const svc = new ConfigObjectsService({ prisma: makePrisma() });
    await expect(svc.get(user, "ws1", "destination", "nope")).rejects.toThrow(/does not exist/);
  });

  it("delete returns null when the object is missing (idempotent)", async () => {
    const svc = new ConfigObjectsService({ prisma: makePrisma() });
    await expect(svc.delete(user, "ws1", "destination", "nope")).resolves.toBeNull();
  });

  it("list maps stored rows to objects with id/type/workspaceId", async () => {
    const prisma = makePrisma({
      configurationObject: {
        findMany: vi.fn(async () => [{ id: "d1", workspaceId: "ws1", config: { name: "dest" }, updatedAt: null }]),
      },
    });
    const svc = new ConfigObjectsService({ prisma });
    const objects = await svc.list(user, "ws1", "destination");
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({ id: "d1", type: "destination", workspaceId: "ws1", name: "dest" });
  });

  it("listWorkspaces uses workspaceAccess for non-admins", async () => {
    const prisma = makePrisma({
      userProfile: { findUnique: vi.fn(async () => ({ id: "user-1", admin: false })) },
      workspaceAccess: {
        findMany: vi.fn(async () => [{ workspace: { id: "ws1", name: "WS", slug: "ws" } }]),
      },
    });
    const svc = new ConfigObjectsService({ prisma });
    const res = await svc.listWorkspaces(user);
    expect(res).toEqual([{ id: "ws1", name: "WS", slug: "ws" }]);
    expect(prisma.workspace.findMany).not.toHaveBeenCalled();
  });

  it("listWorkspaces lists all workspaces for admins", async () => {
    const prisma = makePrisma({
      userProfile: { findUnique: vi.fn(async () => ({ id: "user-1", admin: true })) },
      workspace: { findMany: vi.fn(async () => [{ id: "ws1", name: "WS", slug: "ws" }]) },
    });
    const svc = new ConfigObjectsService({ prisma });
    const res = await svc.listWorkspaces(user);
    expect(res).toEqual([{ id: "ws1", name: "WS", slug: "ws" }]);
    expect(prisma.workspaceAccess.findMany).not.toHaveBeenCalled();
  });
});
