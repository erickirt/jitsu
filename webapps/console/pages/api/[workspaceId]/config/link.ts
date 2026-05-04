import { z } from "zod";
import { Api, inferUrl, nextJsApiHandler, verifyAccessWithRole } from "../../../../lib/api";
import { db } from "../../../../lib/server/db";
import { randomId } from "juava";
import { scheduleSync } from "../../../../lib/server/sync";
import { ConfigurationObjectLinkDbModel } from "../../../../prisma/schema";
import { SyncOptionsType } from "../../../../lib/schema";
import { ApiError } from "../../../../lib/shared/errors";
import { MASKED_SECRET, getCoreDestinationTypeNonStrict } from "../../../../lib/schema/destinations";
import { configObjectAuditLog } from "../../../../lib/server/audit-log";

export type SyncDbModel = Omit<z.infer<typeof ConfigurationObjectLinkDbModel>, "data"> & {
  data?: SyncOptionsType;
};

const postAndPutCfg = {
  auth: true,
  types: {
    query: z.object({ workspaceId: z.string(), runSync: z.string().optional(), strict: z.string().optional() }),
    body: z.object({
      id: z.string().optional(),
      data: z.any().optional(),
      toId: z.string(),
      fromId: z.string(),
      type: z.string().optional(),
    }),
  },
  handle: async (ctx: any) => {
    const {
      body,
      user,
      query: { workspaceId, runSync, strict },
      req,
    } = ctx;
    const { id, toId, fromId, data = undefined, type = "push" } = body;
    await verifyAccessWithRole(user, workspaceId, "editEntities");

    // Validate connection data if strict mode is enabled
    if (strict === "true" && data !== undefined) {
      if (type === "sync") {
        // Validate against SyncOptionsType
        const parseResult = SyncOptionsType.safeParse(data);
        if (!parseResult.success) {
          throw new ApiError(
            `Invalid sync options: ${parseResult.error.message}`,
            { zodError: parseResult.error },
            { status: 400 }
          );
        }
      } else {
        // type === "push" or undefined - validate against destination's connectionOptions
        const destination = await db.prisma().configurationObject.findFirst({
          where: { workspaceId, id: toId, type: "destination", deleted: false },
        });

        if (destination) {
          const destinationType = getCoreDestinationTypeNonStrict(destination.config?.["destinationType"]);
          if (destinationType?.connectionOptions) {
            const parseResult = destinationType.connectionOptions.safeParse(data);
            if (!parseResult.success) {
              throw new ApiError(
                `Invalid connection options for ${destination.config?.["destinationType"]}: ${parseResult.error.message}`,
                { zodError: parseResult.error },
                { status: 400 }
              );
            }
          }
        }
      }
    }
    const fromType = type === "sync" ? "service" : "stream";

    // we allow duplicates of service=>dst links because they may have different streams and scheduling
    const existingLink =
      type === "push"
        ? await db.prisma().configurationObjectLink.findFirst({
            where: { workspaceId: workspaceId, toId, fromId, deleted: false },
          })
        : id
        ? await db
            .prisma()
            .configurationObjectLink.findFirst({ where: { workspaceId: workspaceId, id, deleted: false } })
        : undefined;

    if (!id && existingLink) {
      throw new Error(`Link from '${fromId}' to '${toId}' already exists`);
    }

    const co = db.prisma().configurationObject;
    if (
      !(await co.findFirst({
        where: { workspaceId: workspaceId, type: fromType, id: fromId, deleted: false },
      }))
    ) {
      throw new Error(`${fromType} object with id '${fromId}' not found in the workspace '${workspaceId}'`);
    }
    if (
      !(await co.findFirst({
        where: { workspaceId: workspaceId, type: "destination", id: toId, deleted: false },
      }))
    ) {
      throw new Error(`Destination object with id '${toId}' not found in the workspace '${workspaceId}'`);
    }
    let createdOrUpdated: SyncDbModel;
    if (existingLink) {
      createdOrUpdated = (await db.prisma().configurationObjectLink.update({
        where: { id: existingLink.id },
        data: { data, deleted: false, workspaceId },
      })) as SyncDbModel;
      // Schedule changes are picked up by syncctl on its next /api/admin/export/syncs poll.
      await configObjectAuditLog(user, workspaceId, createdOrUpdated.id, "link", "update", {
        prevVersion: existingLink,
        newVersion: createdOrUpdated,
      });
    } else {
      createdOrUpdated = (await db.prisma().configurationObjectLink.create({
        data: {
          id: `${workspaceId}-${fromId.substring(fromId.length - 4)}-${toId.substring(toId.length - 4)}-${randomId(6)}`,
          workspaceId,
          fromId,
          toId,
          data,
          type,
        },
      })) as SyncDbModel;
      await configObjectAuditLog(user, workspaceId, createdOrUpdated.id, "link", "create", {
        newVersion: createdOrUpdated,
      });
    }
    if (type === "sync" && (runSync === "true" || runSync === "1")) {
      await scheduleSync({
        req,
        user,
        trigger: "manual",
        workspaceId,
        syncIdOrModel: createdOrUpdated.id,
      });
    }
    return { id: createdOrUpdated.id, created: !existingLink };
  },
};

export const api: Api = {
  url: inferUrl(__filename),
  GET: {
    auth: true,
    types: {
      query: z.object({ workspaceId: z.string() }),
    },
    handle: async ({ user, query: { workspaceId } }) => {
      const role = await verifyAccessWithRole(user, workspaceId, "readEntities");
      const links = await db.prisma().configurationObjectLink.findMany({
        where: { workspaceId: workspaceId, deleted: false },
        orderBy: { createdAt: "asc" },
      });
      if (!role.editEntities) {
        for (const link of links) {
          const functionsEnv = link.data?.["functionsEnv"];
          if (typeof functionsEnv === "object" && functionsEnv !== null) {
            for (const key in functionsEnv) {
              functionsEnv[key] = MASKED_SECRET;
            }
          }
        }
      }
      return {
        links,
      };
    },
  },
  POST: postAndPutCfg,
  PUT: postAndPutCfg,
  DELETE: {
    auth: true,
    types: {
      query: z.union([
        z.object({ workspaceId: z.string(), type: z.string().optional(), toId: z.string(), fromId: z.string() }),
        z.object({ workspaceId: z.string(), type: z.string().optional(), id: z.string() }),
      ]),
    },
    handle: async ({ user, query: { workspaceId, fromId, toId, id }, req }) => {
      await verifyAccessWithRole(user, workspaceId, "deleteEntities");
      if (id) {
        if (fromId || toId) {
          throw new ApiError("You can't specify 'fromId' or 'toId' with 'id'", {}, { status: 400 });
        }
        const updatedLink = await db
          .prisma()
          .configurationObjectLink.update({ where: { workspaceId, id }, data: { deleted: true } });
        if (!updatedLink) {
          return { deleted: false };
        }
        // Sync deletions are picked up by syncctl on its next /api/admin/export/syncs poll.
        await configObjectAuditLog(user, workspaceId, updatedLink.id, "link", "delete", {
          prevVersion: updatedLink,
        });
        return { deleted: true };
      } else if (fromId && toId) {
        if (id) {
          throw new ApiError("You can't specify 'id' with 'fromId' and 'toId'", {}, { status: 400 });
        }
        const updatedLinks = await db.prisma().configurationObjectLink.updateManyAndReturn({
          where: { workspaceId, toId, fromId, deleted: false },
          data: { deleted: true },
        });
        for (const updatedLink of updatedLinks) {
          // Sync deletions are picked up by syncctl on its next /api/admin/export/syncs poll.
          await configObjectAuditLog(user, workspaceId, updatedLink.id, "link", "delete", {
            prevVersion: updatedLink,
          });
        }
        return { deleted: updatedLinks.length > 0 };
      } else {
        return { deleted: false };
      }
    },
  },
};
export default nextJsApiHandler(api);
