import { createRoute, verifyAdmin } from "../../../lib/api";
import { clickhouse, dateToClickhouse } from "../../../lib/server/clickhouse";
import { db } from "../../../lib/server/db";
import { getServerLog } from "../../../lib/server/log";
import { StatusChangeDbModel } from "../../../prisma/schema";
import { z } from "zod";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { stopwatch } from "juava";
import { getAppEndpoint } from "../../../lib/domains";

dayjs.extend(utc);

const log = getServerLog("notifications");

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

type StatusChange = Omit<z.infer<typeof StatusChangeDbModel>, "id">;

type StatusChangeEntity = StatusChange & {
  type: "push" | "sync";
  workspaceName: string;
  slug: string;
  fromName: string;
  toName: string;
};

function key(actorId: string, tableName?: string) {
  return tableName ? `${actorId} ${tableName}` : actorId;
}

export default createRoute()
  .GET({
    auth: true,
  })
  .handler(async ({ req, res, query, user }) => {
    await verifyAdmin(user);
    const publicEndpoints = getAppEndpoint(req);

    const currentRunTime = new Date();
    let previousRunTime = new Date();
    let previousChangeId = 0;
    let notificationsLastRun = await db.prisma().globalProps.findFirst({ where: { name: "notificationsLastRun" } });
    if (!notificationsLastRun) {
      notificationsLastRun = await db.prisma().globalProps.create({
        data: {
          name: "notificationsLastRun",
          value: { timestamp: currentRunTime, lastProcessedChangeId: previousChangeId },
        },
      });
    } else {
      const value = (notificationsLastRun.value as any) || {};
      if (value.timestamp) {
        previousRunTime = new Date(value.timestamp);
      }
      previousChangeId = value.lastProcessedChangeId || 0;
    }
    let currentChangeId = previousChangeId;
    log
      .atInfo()
      .log(`Previous run time: ${previousRunTime.toISOString()} Last processed change id: ${previousChangeId}`);
    // add some overlap to avoid missing status changes
    previousRunTime.setMinutes(previousRunTime.getMinutes() - 10);

    const batches: Record<string, StatusChangeEntity> = {};
    const batchesByTableName: Record<string, StatusChangeEntity> = {};

    // load all objects which we monitor status changes for along with their last status change
    // noinspection SqlResolve
    const r = await db.pgPool().query(`with status_changes as (SELECT DISTINCT ON ("actorId","tableName") *
                                                               FROM newjitsu."StatusChange"
                                                               ORDER BY "actorId", "tableName", id DESC)

                                       select w.id                          as "workspaceId",
                                              w.slug                        as slug,
                                              w.name                        as "workspaceName",
                                              fr.config->>'name'           as "fromName",
                                              too.config->>'name'          as "toName",
                                              coalesce(sc."actorId", cl.id) as "actorId",
                                              cl.type,
                                              sc."tableName",
                                              sc.timestamp,
                                              sc."status",
                                              sc."description",
                                              sc."previousStatus",
                                              sc."previousTimestamp"
                                       from newjitsu."ConfigurationObjectLink" cl
                                                join newjitsu."Workspace" w on w.id = cl."workspaceId"
                                                join newjitsu."ConfigurationObject" fr on fr.id = cl."fromId"
                                                join newjitsu."ConfigurationObject" too on too.id = cl."toId"
                                                left join status_changes sc on sc."actorId" = cl.id
                                       where ( (cl.type = 'push' and  data ->> 'mode' = 'batch') or cl.type = 'sync' )
                                         and cl.deleted = 'false' and fr.deleted = false and too.deleted = false
                                         and w.deleted = false
                                         `);
    for (const row of r.rows) {
      batches[key(row.actorId)] = row;
      if (row["tableName"]) {
        batchesByTableName[key(row.actorId, row["tableName"])] = row;
      }
    }

    const changeId = await loadBatchStatusesChanges(previousRunTime, batches, batchesByTableName);
    currentChangeId = Math.max(changeId, currentChangeId);

    const changeId2 = await loadSyncStatusesChanges(previousRunTime, batches);
    currentChangeId = Math.max(changeId2, currentChangeId);

    const statusChanges = await db.prisma().statusChange.findMany({
      where: {
        AND: [{ id: { gt: previousChangeId } }],
        OR: [
          {
            previousStatus: { not: null },
          },
          {
            status: { not: "SUCCESS" },
          },
        ],
      },
      orderBy: [{ actorId: "asc" }, { tableName: "asc" }, { id: "asc" }],
    });

    log.atInfo().log(`Got ${statusChanges.length} new status changes`);

    const aggrStatues: Record<string, StatusChange[]> = {};

    for (const change of statusChanges) {
      const k = key(change.actorId, change.tableName);

      const statuses = aggrStatues[k] || [];
      if (statuses.length == 0) {
        aggrStatues[k] = statuses;
      } else if (statuses[statuses.length - 1].status == "SUCCESS") {
        // we are not interested in intermediate success statuses
        statuses.pop();
      }
      statuses.push(change);
      currentChangeId = Number(change.id);
    }

    for (const [k, statuses] of Object.entries(aggrStatues)) {
      const lastStatus = statuses[statuses.length - 1];
      const b = batches[key(lastStatus.actorId)];
      const details = statuses
        .map(s => `${s.timestamp.toISOString()} ${s.status}${s.description ? " " + s.description : ""}`)
        .join("\n");
      if (lastStatus.status == "SUCCESS") {
        await sendSlackNotification(b, "RECOVERED", lastStatus, details, publicEndpoints.baseUrl);
      } else {
        await sendSlackNotification(b, "FAILED", lastStatus, details, publicEndpoints.baseUrl);
      }
    }

    await db.prisma().globalProps.update({
      where: { id: notificationsLastRun.id },
      data: {
        name: "notificationsLastRun",
        value: { timestamp: currentRunTime, lastProcessedChangeId: currentChangeId },
      },
    });
  })
  .toNextApiHandler();

async function loadSyncStatusesChanges(
  fromTimestamp: Date,
  batches: Record<string, Partial<StatusChange>>
): Promise<number> {
  const sw = stopwatch();
  let statusChanges = 0;
  let changeId = 0;

  const r = await db.pgPool().query(
    `
        select *
        from newjitsu.source_task
        where status not in ('RUNNING', 'CANCELLED', 'SKIPPED')
          and updated_at > $1
        order by updated_at asc
    `,
    [fromTimestamp]
  );
  log.atInfo().log(`Got ${r.rowCount} sync task records in ${sw.elapsedPretty()}`);
  for (const row of r.rows) {
    let batch = batches[key(row.sync_id)];
    const status = row.status;
    if (!batch) {
      log.atWarn().log(`Sync ${row.sync_id} not found`);
      continue;
    }
    const rowTimestamp = row.updated_at;
    //log.atInfo().log(`SS`, rowTimestamp, typeof rowTimestamp, batch.timestamp, typeof batch.timestamp);

    if (!batch.timestamp || (rowTimestamp.getTime() > batch.timestamp.getTime() && status != batch.status)) {
      const newBatch: StatusChange = {
        workspaceId: batch.workspaceId!,
        actorId: batch.actorId!,
        tableName: "",
        timestamp: rowTimestamp,
        status: status,
        description: row.error,
        previousStatus: batch.status,
        previousTimestamp: batch.timestamp,
      };
      const r = await db.prisma().statusChange.create({
        data: newBatch,
      });
      changeId = Number(r.id);
      batches[key(newBatch.actorId)] = { ...batches[key(newBatch.actorId)], ...newBatch };
      statusChanges++;
      log.atInfo().log(`Sync ${batch.actorId} status changed from ${batch.status} to ${status}`);
    }
  }
  log.atInfo().log(`Sync tasks processed. Status changes: ${statusChanges}. Elapsed: ${sw.elapsedPretty()}`);
  return changeId;
}

async function loadBatchStatusesChanges(
  fromTimestamp: Date,
  batches: Record<string, StatusChangeEntity>,
  batchesByTable: Record<string, StatusChangeEntity>
): Promise<number> {
  const sw = stopwatch();
  const batchesIds = Object.entries(batches)
    .filter(([_, b]) => b.type === "push")
    .map(([id, _]) => id);
  let statusChanges = 0;
  let changeId = 0;

  const metricsSchema = process.env.CLICKHOUSE_METRICS_SCHEMA || process.env.CLICKHOUSE_DATABASE || "newjitsu_metrics";

  // noinspection SqlResolve
  const eventsLogQuery: string = `select actorId, level, timestamp, message
                                  from ${metricsSchema}.events_log
                                  where type = 'bulker_batch'
                                    and timestamp > toDateTime({fromTimestamp:String}, 'UTC')
                                    and has({actorIds:Array(String)}, actorId)
                                  order by timestamp
                                          asc`;
  const eventsLogRes = (await (
    await clickhouse.query({
      query: eventsLogQuery,
      query_params: {
        fromTimestamp: dateToClickhouse(fromTimestamp),
        actorIds: batchesIds,
      },
      clickhouse_settings: {
        wait_end_of_query: 1,
      },
    })
  ).json()) as any;
  log.atInfo().log(`Got ${eventsLogRes.data.length} events log records in ${sw.elapsedPretty()}`);
  if (eventsLogRes.data && eventsLogRes.data.length > 0) {
    for (const row of eventsLogRes.data) {
      let batch = batches[key(row.actorId)];
      const status = row.level === "error" ? "FAILED" : "SUCCESS";
      let message: any = {};
      try {
        message = JSON.parse(row.message);
      } catch (e) {}
      let tableName = message.representation?.targetName || message.representation?.name;
      if (tableName) {
        tableName = tableName
          .replace(/_tmp\d{12,16}$/, "")
          .replace(/_\d{4}_\d{2}_\d{2}T\d{2}_\d{2}_\d{2}(?:_\d+)?[.](?:ndjson|csv)(?:[.]gz)?$/, "");
        batch = batchesByTable[key(row.actorId, tableName)] || batch;
      }

      if (!batch) {
        log.atWarn().log(`Batch ${row.actorId} not found`);
        continue;
      }
      const rowTimestamp = dayjs(row.timestamp, { utc: true }).toDate();
      //log.atInfo().log(`EL`, key(row.actorId, tableName), rowTimestamp, batch.timestamp);

      if (!batch.timestamp || (rowTimestamp.getTime() > batch.timestamp.getTime() && status != batch.status)) {
        const newBatch: StatusChange = {
          workspaceId: batch.workspaceId!,
          actorId: batch.actorId!,
          tableName: tableName ?? "",
          timestamp: rowTimestamp,
          status: status,
          description: message.error,
          previousStatus: batch.status,
          previousTimestamp: batch.timestamp,
        };
        const b = await db.prisma().statusChange.create({
          data: newBatch,
        });
        changeId = Number(b.id);
        if (tableName) {
          batchesByTable[key(newBatch.actorId, tableName)] = {
            ...batchesByTable[key(newBatch.actorId, tableName)],
            ...newBatch,
          };
        } else {
          batches[key(newBatch.actorId)] = { ...batches[key(newBatch.actorId)], ...newBatch };
        }
        statusChanges++;
        log.atInfo().log(`Batch ${batch.actorId} ${tableName} status changed from ${batch.status} to ${status}`);
      }
    }
    log.atInfo().log(`Events log processed. Status changes: ${statusChanges}. Elapsed: ${sw.elapsedPretty()}`);
  }
  return changeId;
}

type JobStatus = "FAILED" | "RECOVERED";

type SlackPayload = {
  text: string;
  blocks?: any[];
  attachments?: any[];
};

async function sendSlackNotification(
  entity: StatusChangeEntity,
  status: JobStatus,
  lastStatus: StatusChange,
  details: string,
  baseUrl: string
): Promise<boolean> {
  const url =
    entity.type == "sync"
      ? `${baseUrl}/${entity.slug}/syncs/tasks?query={syncId:'${entity.actorId}'}`
      : `${baseUrl}/${entity.slug}/data?query={activeView%3A'bulker'%2CviewState%3A{bulker%3A{actorId%3A'${entity.actorId}'}}}`;
  const name = `${entity.fromName} → ${entity.toName}`;
  const jobName = entity.type == "sync" ? `Sync Task *${name}*` : `Batch *${name}*`;
  const message =
    status === "FAILED"
      ? `:red_circle: FAILED ${jobName} [${entity.workspaceName}]`
      : `:large_green_circle: RECOVERED ${jobName} [${entity.workspaceName}]`;
  const color = status === "FAILED" ? "#ff0000" : "#36a64f"; // Red for failed, Green for recovered

  const payload: SlackPayload = {
    text: message,
    attachments: [
      {
        color: color,
        title: "Details",
        ts: lastStatus.timestamp.getTime() / 1000,
        title_link: url,
        text: details, // This can be a very long text body
      },
    ],
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: message,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Last status: *${lastStatus.status}*\n${
            lastStatus.tableName ? "Batch Table: *" + lastStatus.tableName + "*\n" : ""
          }<${url}|Open in Jitsu...>`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `No additional reports will be sent for this entity unless the status changes.`,
          },
        ],
      },
      // {
      //   type: "divider",
      // },
    ],
  };

  try {
    const res = await fetch(SLACK_WEBHOOK_URL!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      log
        .atError()
        .log(
          `Failed to send Slack notification: ${status} ${jobName}${
            lastStatus.tableName ? " t:" + lastStatus.tableName : ""
          } [${entity.workspaceName}]: ${res.status} ${res.statusText}`
        );
      return false;
    }
    log
      .atInfo()
      .log(
        `Slack notification sent: ${status} ${jobName}${lastStatus.tableName ? " t:" + lastStatus.tableName : ""} [${
          entity.workspaceName
        }]`
      );
    return true;
  } catch (error: any) {
    log
      .atError()
      .log(
        `Failed to send Slack notification: ${status} ${jobName}${
          lastStatus.tableName ? " t:" + lastStatus.tableName : ""
        } [${entity.workspaceName}]: ${error.message}`
      );
    return false;
  }
}
