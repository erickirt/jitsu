import { describe, expect, it, vi } from "vitest";
import { createHash } from "juava";

// send401 reaches for the public origin to build the WWW-Authenticate metadata
// URL. Stub it so the checker doesn't depend on env config.
vi.mock("../lib/server/origin", async importOriginal => ({
  ...(await importOriginal<any>()),
  getPublicOrigin: () => "https://console.example.com",
}));

import { AuthChecker } from "../lib/server/mcp-server/auth";

const noopSchedule = (_fn: () => Promise<any>) => {};

function makeReq(authorization: string) {
  return { headers: { authorization } } as any;
}

// Minimal NextApiResponse stand-in. `json()` marks headers as sent, mirroring
// how a real response ends after `res.status(...).json(...)` — the checker uses
// res.headersSent to decide whether the OAuth path already answered.
function makeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    headers: {} as Record<string, string>,
    headersSent: false,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
  };
  return res;
}

const user = {
  id: "user-1",
  email: "u1@example.com",
  name: "User One",
  externalId: "ext-1",
  loginProvider: "github",
};

function makePrisma(overrides: any = {}) {
  return {
    oAuthAccessToken: {
      findUnique: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
      ...overrides.oAuthAccessToken,
    },
    userApiToken: {
      findUnique: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
      ...overrides.userApiToken,
    },
  } as any;
}

describe("AuthChecker.requireAccessToken", () => {
  it("authenticates a valid OAuth access token without consulting the API-key path", async () => {
    const secret = "s3cret";
    const prisma = makePrisma({
      oAuthAccessToken: {
        findUnique: vi.fn(async () => ({
          id: "at-1",
          hash: createHash(secret),
          expiresAt: new Date(Date.now() + 60_000),
          refreshTokenId: "rt-1",
          refreshToken: { user, oauthClientId: "client-1", oauthClient: { name: "Claude" } },
        })),
      },
    });
    const auth = await new AuthChecker(prisma, noopSchedule).requireAccessToken(
      makeReq(`Bearer at-1:${secret}`),
      makeRes()
    );
    expect(auth?.extra?.userId).toBe("user-1");
    expect(auth?.extra?.refreshTokenId).toBe("rt-1");
    expect(prisma.userApiToken.findUnique).not.toHaveBeenCalled();
  });

  it("authenticates a personal API key when the id is not an OAuth token, and bumps lastUsed", async () => {
    const secret = "keysecret";
    const bump = vi.fn(async () => ({}));
    const prisma = makePrisma({
      userApiToken: {
        findUnique: vi.fn(async () => ({
          id: "key-1",
          hash: createHash(secret),
          oauthClientId: null,
          expiresAt: null, // never expires — the CI case
          name: "ci-key",
          user,
        })),
        update: bump,
      },
    });
    const scheduled: Array<() => Promise<any>> = [];
    const auth = await new AuthChecker(prisma, fn => scheduled.push(fn)).requireAccessToken(
      makeReq(`Bearer key-1:${secret}`),
      makeRes()
    );
    expect(auth?.extra?.userId).toBe("user-1");
    expect(auth?.extra?.refreshTokenId).toBe("key-1");
    expect(auth?.clientId).toBe("api-key");
    await Promise.all(scheduled.map(fn => fn()));
    expect(bump).toHaveBeenCalledWith({ where: { id: "key-1" }, data: { lastUsed: expect.any(Date) } });
  });

  it("rejects an OAuth refresh token (oauthClientId set) presented as an API key", async () => {
    const secret = "refreshsecret";
    const prisma = makePrisma({
      userApiToken: {
        findUnique: vi.fn(async () => ({
          id: "rt-1",
          hash: createHash(secret),
          oauthClientId: "client-1", // a refresh token, not a personal key
          expiresAt: null,
          user,
        })),
      },
    });
    const res = makeRes();
    const auth = await new AuthChecker(prisma, noopSchedule).requireAccessToken(makeReq(`Bearer rt-1:${secret}`), res);
    expect(auth).toBeUndefined();
    expect(res.statusCode).toBe(401);
    expect(res.body.error_description).toMatch(/refresh tokens cannot be used/i);
  });

  it("does not fall through to the API-key path when an OAuth token exists but the secret is wrong", async () => {
    const prisma = makePrisma({
      oAuthAccessToken: {
        findUnique: vi.fn(async () => ({
          id: "at-1",
          hash: createHash("right"),
          expiresAt: new Date(Date.now() + 60_000),
          refreshTokenId: "rt-1",
          refreshToken: { user, oauthClientId: "client-1", oauthClient: { name: "Claude" } },
        })),
      },
    });
    const res = makeRes();
    const auth = await new AuthChecker(prisma, noopSchedule).requireAccessToken(makeReq("Bearer at-1:wrong"), res);
    expect(auth).toBeUndefined();
    expect(res.statusCode).toBe(401);
    // The wrong secret must not send a second 401 via the key path.
    expect(prisma.userApiToken.findUnique).not.toHaveBeenCalled();
  });
});
