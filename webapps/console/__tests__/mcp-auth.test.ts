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

function makeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    setHeader() {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

const user = { id: "user-1", email: "u1@example.com", name: "User One", externalId: "ext-1", loginProvider: "github" };

function makePrisma(userApiToken: any) {
  return {
    oAuthAccessToken: { findUnique: vi.fn(async () => null) },
    userApiToken: { findUnique: vi.fn(async () => userApiToken), update: vi.fn(async () => ({})) },
  } as any;
}

describe("AuthChecker: MCP auth via personal API key", () => {
  it("authenticates a personal key (oauthClientId null)", async () => {
    const secret = "keysecret";
    const auth = await new AuthChecker(
      makePrisma({ id: "key-1", hash: createHash(secret), oauthClientId: null, expiresAt: null, user }),
      noopSchedule
    ).requireAccessToken(makeReq(`Bearer key-1:${secret}`), makeRes());
    expect(auth?.extra?.userId).toBe("user-1");
    expect(auth?.clientId).toBe("api-key");
  });

  it("rejects an OAuth refresh token (oauthClientId set) presented as a key", async () => {
    const secret = "refreshsecret";
    const res = makeRes();
    const auth = await new AuthChecker(
      makePrisma({ id: "rt-1", hash: createHash(secret), oauthClientId: "client-1", expiresAt: null, user }),
      noopSchedule
    ).requireAccessToken(makeReq(`Bearer rt-1:${secret}`), res);
    expect(auth).toBeUndefined();
    expect(res.statusCode).toBe(401);
  });
});
