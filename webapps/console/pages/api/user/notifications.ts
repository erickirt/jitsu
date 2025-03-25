import { createRoute } from "../../../lib/api";
import { z } from "zod";
import { db } from "../../../lib/server/db";
import { getUserPreferenceService, UserNotificationsPreferences } from "../../../lib/server/user-preferences";

export default createRoute()
  .GET({ auth: true, result: UserNotificationsPreferences })
  .handler(async ({ user }) => {
    const pref = await getUserPreferenceService(db.prisma()).getPreferences({ userId: user.internalId });
    return UserNotificationsPreferences.parse(pref?.notifications || {});
  })
  .POST({ auth: true, body: UserNotificationsPreferences })
  .handler(async ({ user, body }) => {
    const pref = await getUserPreferenceService(db.prisma()).getPreferences({ userId: user.internalId });
    pref.notifications = UserNotificationsPreferences.parse({ ...pref.notifications, ...body });
    await getUserPreferenceService(db.prisma()).savePreference({ userId: user.internalId }, pref);
  })
  .toNextApiHandler();
