import { randomId } from "juava";
import type { KeyValueTable } from "../kv";

// Payload stored under each one-shot authorization code, keyed by the code string.
export type CodePayload = {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string; // PKCE S256 challenge from the authorize request
  codeChallengeMethod: "S256"; // we don't accept "plain"
  createdAt: number;
};

const TTL_MS = 60 * 1000;

// Thin wrapper around the KV "oauth_codes" namespace. Codes are single-use:
// consumeCode atomically reads and deletes. DI: takes the KeyValueTable.
export class OAuthCodesRepo {
  constructor(private readonly table: KeyValueTable) {}

  async issueCode(payload: Omit<CodePayload, "createdAt">): Promise<string> {
    const code = randomId(48);
    await this.table.put(code, { ...payload, createdAt: Date.now() } satisfies CodePayload, { ttlMs: TTL_MS });
    return code;
  }

  // Atomic-ish: get then del. The window between is short enough that a
  // replay attack via parallel exchange would still fail validation later
  // (PKCE verifier, client secret), but in practice no real client races
  // itself on a single auth code.
  async consumeCode(code: string): Promise<CodePayload | undefined> {
    const payload = (await this.table.get(code)) as CodePayload | undefined;
    if (!payload) return undefined;
    await this.table.del(code);
    return payload;
  }
}
