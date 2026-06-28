import { NextApiRequest } from "next";
import { getServerEnv } from "./serverEnv";

export function getRequestHost(req: NextApiRequest) {
  return (req.headers["x-forwarded-host"] || req.headers.host) as string;
}

/**
 * Returns the public origin (scheme + host, no trailing slash) at which this
 * console instance is reachable from the outside world. Used for OAuth issuer
 * URLs, email links, MCP server metadata — anywhere we need to spell out a
 * URL that ends up in someone else's hands.
 *
 * Resolution order:
 *   1. `JITSU_PUBLIC_URL` / `JITSU_PUBLIC` — the canonical setting in our
 *      deployments; dev-scripts/run-app.ts sets this to the portless host
 *      (e.g. https://console-feat.jitsu.localhost) when JITSU_BRANCH_SUFFIX
 *      is in use.
 *   2. `VERCEL_URL` — auto-populated on Vercel previews; needs `https://`
 *      prefix since Vercel only exports the host.
 *   3. `NEXTAUTH_URL` — last resort; usually present when NextAuth is wired.
 *   4. `http://localhost:3000` — local-dev convenience so the function is
 *      total and callers don't have to handle undefined.
 */
export function getPublicOrigin(): string {
  const env = getServerEnv();
  const raw =
    env.JITSU_PUBLIC_URL ||
    env.JITSU_PUBLIC ||
    (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : undefined) ||
    env.NEXTAUTH_URL ||
    "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}

/**
 * Returns the best-effort client IP for rate limiting and logging. Takes the
 * rightmost entry in X-Forwarded-For (added by our closest trusted proxy and
 * therefore harder to spoof than the leftmost client-supplied value) and falls
 * back to the raw socket address when the header is absent.
 */
export function getClientIp(req: NextApiRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const list = (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(",");
    const last = list[list.length - 1]?.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function getTopLevelDomain(requestDomain: string): string {
  const parts = requestDomain.split(".");
  if (parts.length < 2) {
    return parts[0];
  }
  return parts.slice(-2).join(".");
}

export function isSecure(req: NextApiRequest) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (forwardedProto === "https") {
    return true;
  }
  return !!((req.socket || {}) as any).encrypted;
}
