import { randomUUID } from "node:crypto";
import type { NextApiRequest, NextApiResponse } from "next";
import type { PrismaClient } from "@prisma/client";
import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { db } from "../db";
import { consoleKv, type KvStore } from "../kv";
import { getUser } from "../../api";
import { getServerLog } from "../log";
import { getServerEnv } from "../serverEnv";
import { AuthChecker } from "./auth";
import { KvEventStore } from "./event-store";
import { OAuthHandlers, type GetCurrentUser } from "./oauth";
import { registerTools } from "./tools";

const log = getServerLog("mcp-server");

export interface McpServerDeps {
  prisma: PrismaClient;
  kv: KvStore;
  baseUrl: string; // e.g. "https://console.jitsu.com" — for issuer / metadata
  getCurrentUser: GetCurrentUser; // resolves the logged-in user from req cookies
  accessTokenTtlSec?: number;
  refreshTokenTtlDays?: number;
}

// Single class that owns the MCP harness. All page handlers in pages/api/mcp/*
// are 1-line wrappers that delegate here. Constructor takes every dep
// explicitly — never reaches for db.prisma()/consoleKv internally — so the
// class is testable via `new McpServer({ prisma: fakePrisma, ... })`.
export class McpServer {
  private readonly sdkServer: SdkMcpServer;
  private readonly oauth: OAuthHandlers;
  private readonly auth: AuthChecker;
  private readonly eventStore: KvEventStore;

  constructor(private readonly deps: McpServerDeps) {
    this.sdkServer = new SdkMcpServer({ name: "jitsu", version: "0.1.0" });
    registerTools(this.sdkServer);
    this.oauth = new OAuthHandlers({
      prisma: deps.prisma,
      kv: deps.kv,
      baseUrl: deps.baseUrl,
      getCurrentUser: deps.getCurrentUser,
      accessTokenTtlSec: deps.accessTokenTtlSec ?? 3600,
      refreshTokenTtlDays: deps.refreshTokenTtlDays ?? 90,
    });
    this.auth = new AuthChecker(deps.prisma, deps.baseUrl);
    this.eventStore = new KvEventStore(deps.kv);
  }

  // ─── OAuth endpoints ────────────────────────────────────────────────────
  handleRegister = (req: NextApiRequest, res: NextApiResponse) => this.oauth.register(req, res);
  handleApprove = (req: NextApiRequest, res: NextApiResponse) => this.oauth.approve(req, res);
  handleDeny = (req: NextApiRequest, res: NextApiResponse) => this.oauth.deny(req, res);
  handleToken = (req: NextApiRequest, res: NextApiResponse) => this.oauth.token(req, res);

  // ─── Discovery ──────────────────────────────────────────────────────────
  handleAuthServerMetadata = (req: NextApiRequest, res: NextApiResponse) =>
    this.oauth.authServerMetadata(req, res);
  handleProtectedResourceMeta = (req: NextApiRequest, res: NextApiResponse) =>
    this.oauth.protectedResourceMetadata(req, res);

  // ─── MCP transport ──────────────────────────────────────────────────────
  handleMcpRequest = async (req: NextApiRequest, res: NextApiResponse) => {
    const authInfo = await this.auth.requireAccessToken(req, res);
    if (!authInfo) return; // 401 already sent
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      eventStore: this.eventStore,
    });
    try {
      await this.sdkServer.connect(transport);
      await transport.handleRequest(req, res, { authInfo });
    } catch (e) {
      log.atError().withCause(e).log("MCP transport error");
      if (!res.writableEnded) {
        res.status(500).json({ error: "internal_error" });
      }
    }
  };

  // ─── Used by /api/user/keys DELETE handler ──────────────────────────────
  deleteUserApiTokenWithMcpCascade = (refreshTokenId: string) =>
    this.oauth.deleteUserApiTokenWithMcpCascade(refreshTokenId);
}

// Singleton wiring — the ONLY place that reaches for global deps. Inner
// classes never call db.prisma() or consoleKv() directly.
export const mcpServer = new McpServer({
  prisma: db.prisma(),
  kv: consoleKv(),
  baseUrl: (() => {
    const env = getServerEnv();
    return env.JITSU_PUBLIC_URL ?? env.JITSU_PUBLIC ?? env.NEXTAUTH_URL ?? "http://localhost:3000";
  })(),
  // Adapt the existing getUser() (which returns SessionUser) into the
  // GetCurrentUser shape OAuthHandlers expects.
  getCurrentUser: async (req, res) => {
    const u = await getUser(res, req);
    return u ? { id: u.internalId, email: u.email, name: u.name } : undefined;
  },
});
