import type { NextApiRequest, NextApiResponse } from "next";
import type { PrismaClient } from "@prisma/client";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { checkHash } from "juava";
import { getServerLog } from "../log";
import { getPublicOrigin } from "../origin";
import { type FireAndForget, detachedPromise } from "../kv";

const log = getServerLog("mcp-auth");

function bearer(req: NextApiRequest): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const [scheme, token] = h.split(" ", 2);
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}

// Mints a 401 response that points the client at our OAuth metadata
// (per MCP / RFC 9728). Without this header, MCP clients won't know how
// to start the OAuth flow.
function send401(res: NextApiResponse, error: string, description: string) {
  const base = getPublicOrigin();
  res.setHeader(
    "WWW-Authenticate",
    `Bearer realm="jitsu-mcp", error="${error}", error_description="${description}", resource_metadata="${base}/.well-known/oauth-protected-resource"`
  );
  res.status(401).json({ error, error_description: description });
}

export class AuthChecker {
  constructor(private readonly prisma: PrismaClient, private readonly schedule: FireAndForget = detachedPromise) {}

  async requireAccessToken(req: NextApiRequest, res: NextApiResponse): Promise<AuthInfo | undefined> {
    const raw = bearer(req);
    if (!raw) {
      send401(res, "missing_token", "Authorization header either missing or malformed");
      return undefined;
    }
    const [tokenId, secret] = raw.split(":");
    if (!tokenId || !secret) {
      send401(res, "invalid_token", "Token format must be tokenId:secret");
      return undefined;
    }
    const at = await this.prisma.oAuthAccessToken.findUnique({
      where: { id: tokenId },
      include: { refreshToken: { include: { user: true, oauthClient: true } } },
    });
    if (!at) {
      send401(res, "invalid_token", "Access token not found");
      return undefined;
    }
    if (!checkHash(at.hash, secret)) {
      send401(res, "invalid_token", "Access token secret mismatch");
      return undefined;
    }
    if (at.expiresAt.getTime() < Date.now()) {
      send401(res, "expired_token", "Access token has expired");
      return undefined;
    }
    this.schedule(async () => {
      const now = new Date();
      await this.prisma.oAuthAccessToken
        .update({ where: { id: at.id }, data: { lastUsed: now } })
        .catch(e => log.atWarn().withCause(e).log("Failed to bump OAuthAccessToken.lastUsed"));
      await this.prisma.userApiToken
        .update({ where: { id: at.refreshTokenId }, data: { lastUsed: now } })
        .catch(e => log.atWarn().withCause(e).log("Failed to bump UserApiToken.lastUsed"));
    });

    const user = at.refreshToken.user;
    const clientId = at.refreshToken.oauthClientId ?? "unknown";
    return {
      token: raw,
      clientId,
      scopes: [],
      expiresAt: Math.floor(at.expiresAt.getTime() / 1000),
      extra: {
        userId: user.id,
        email: user.email,
        name: user.name,
        // Carried so tools can build a SessionUser for verifyAccess / audit-log
        // without re-querying UserProfile, and so config-object audit rows are
        // attributed to the MCP token (refreshTokenId) and login identity.
        externalId: user.externalId,
        loginProvider: user.loginProvider,
        refreshTokenId: at.refreshTokenId,
        clientName: at.refreshToken.oauthClient?.name,
      },
    };
  }
}
