import { isTruish } from "../shared/chores";
import { db } from "./db";
import { SessionUser } from "../schema";

const enableAuditLog = isTruish(process.env.CONSOLE_ENABLE_AUDIT_LOG);

export async function configObjectAuditLog(
  user: SessionUser,
  workspaceId: string,
  id: string,
  type: string,
  op: "create" | "update" | "delete",
  changes: { prevVersion?: any; newVersion?: any }
) {
  if (enableAuditLog) {
    await db.prisma().auditLog.create({
      data: {
        type: op,
        workspaceId,
        objectId: id,
        userId: user.internalId,
        authType: user.authType,
        changes: {
          objectType: type,
          prevVersion: changes.prevVersion,
          newVersion: changes.newVersion,
        },
      },
    });
  }
}
