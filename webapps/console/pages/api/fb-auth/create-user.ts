import { Api, inferUrl, nextJsApiHandler } from "../../../lib/api";
import { requireDefined } from "juava";
import { getFirebaseUser, linkFirebaseUser } from "../../../lib/server/firebase-server";
import { getOrCreateUser } from "../../../lib/nextauth.config";
import { db } from "../../../lib/server/db";
import { shouldRejectPersonalEmailSignup } from "../../../lib/server/signup-restrictions";
import { CreateUserResult } from "../../../lib/schema";
import { WORK_EMAIL_REQUIRED_MESSAGE } from "../../../lib/shared/email-domains";

export const api: Api = {
  url: inferUrl(__filename),
  POST: {
    auth: false,
    types: { result: CreateUserResult },
    handle: async ({ req }): Promise<CreateUserResult> => {
      const user = requireDefined(await getFirebaseUser(req), `Not authorized`);
      if (user.internalId) {
        throw new Error(
          `Firebase user already has internalId (${user.internalId}), this endpoint should not be called`
        );
      }
      // JITSU-70: enforce the work-email policy only on true first-time signups.
      // An existing user who lost their internalId custom claim (claim reset /
      // stale migration) is matched here by externalId and must be relinked by
      // getOrCreateUser below — never rejected/deleted as if new. The lookup
      // mirrors getOrCreateUser's own (externalId + loginProvider "firebase").
      const existing = await db
        .prisma()
        .userProfile.findFirst({ where: { externalId: user.externalId, loginProvider: "firebase" } });
      // The policy (Firebase-only, GitHub exempt) and the orphan-account cleanup
      // live in the shared helper; here we just report the refusal as a typed
      // result rather than throwing.
      if (!existing && (await shouldRejectPersonalEmailSignup(user))) {
        return { ok: false, rejected: "personal-email", message: WORK_EMAIL_REQUIRED_MESSAGE };
      }
      const dbUser = await getOrCreateUser({
        externalId: user.externalId,
        // TODO: fill with user.loginProvider and update all existing users
        loginProvider: "firebase",
        email: user.email,
        name: user.name || user.email,
        req,
      });
      await linkFirebaseUser(user.externalId, dbUser.id);
      return { ok: true };
    },
  },
};

export default nextJsApiHandler(api);
