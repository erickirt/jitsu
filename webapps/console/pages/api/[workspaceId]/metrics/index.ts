import { z } from "zod";
import { createRoute, verifyAccess, getWorkspace } from "../../../../lib/api";
import { clickhouse } from "../../../../lib/server/clickhouse";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { getServerLog } from "../../../../lib/server/log";
import { requireDefined, rpc } from "juava";
import { db } from "../../../../lib/server/db";

dayjs.extend(utc);

const log = getServerLog("workspace-metrics");

export default createRoute()
  .GET({
    auth: true,
    query: z.object({
      workspaceId: z.string(),
    }),
    streaming: true,
  })
  .handler(async ({ user, query, res }) => {
    const { workspaceId } = query;
    const workspace = await getWorkspace(workspaceId);
    await verifyAccess(user, workspace.id);
    const links = await db.prisma().configurationObjectLink.findMany({
      where: {
        deleted: false,
        OR: [{ type: "push" }, { type: null }],
        workspaceId: workspace.id,
        workspace: { deleted: false },
        from: { deleted: false },
        to: { deleted: false },
      },
      include: { from: true, to: true, workspace: true },
    });
    const connections = links
      .map(link => ({
        connectionId: link.id,
        connectionName: `${link.from.config?.["name"]} -> ${link.to.config?.["name"]}`,
        destinationId: link.to.id,
        destinationName: link.to.config?.["name"],
        sourceId: link.from.id,
        sourceName: link.from.config?.["name"],
      }))
      .reduce((acc, link) => {
        acc[link.connectionId] = link;
        return acc;
      }, {});
    res.writeHead(200, {
      "Content-Type": "text/plain",
    });
    const bulkerURLEnv = requireDefined(process.env.BULKER_URL, "env BULKER_URL is not defined");
    const bulkerAuthKey = process.env.BULKER_AUTH_KEY ?? "";
    // access prometheus API
    const url = bulkerURLEnv + "/queue-sizes/" + workspace.id;
    const promMetrics = await rpc(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${bulkerAuthKey}`,
      },
    });
    if (promMetrics.status === "success" && promMetrics.data?.resultType === "vector") {
      res.write(`# HELP jitsu_queue_sizes connections queues sizes
# TYPE jitsu_queue_sizes gauge\n`);
      for (const metric of promMetrics.data.result) {
        const rawLabels = metric.metric;
        const con = connections[rawLabels.destinationId];
        const labels: Record<string, string> = {
          ...con,
          connectionId: rawLabels.destinationId,
          mode: rawLabels.mode,
          tableName: rawLabels.tableName,
        };
        const labelsStr = Object.entries(labels)
          .map(([key, value]) => `${key}="${value ? value.replaceAll(/"/g, '\\"') : ""}"`)
          .join(",");
        res.write(`jitsu_queue_sizes{${labelsStr}} ${metric.value[1]}\n`);
      }
    }

    const metricsSchema =
      process.env.CLICKHOUSE_METRICS_SCHEMA || process.env.CLICKHOUSE_DATABASE || "newjitsu_metrics";
    const sql = `
        select
            connectionId,
            functionId,
            status,
            sumMerge(events) as eventsCount
        from ${metricsSchema}.mv_metrics
        where
            timestamp >= date_trunc('day', now()) and
            workspaceId = {workspace:String}
        group by connectionId, status, streamId, destinationId, functionId
        order by connectionId desc`;
    try {
      const chResult = (await (
        await clickhouse.query({
          query: sql,
          query_params: {
            workspace: workspace.id,
          },
          clickhouse_settings: {
            wait_end_of_query: 1,
          },
        })
      ).json()) as any;

      res.write(`# HELP jitsu_connection_statuses Number of event status by connectionId, sourceId, destinationId, functionId
# TYPE jitsu_connection_statuses counter\n`);
      chResult.data.forEach((row: any) => {
        const con = connections[row.connectionId];
        const labels: Record<string, string> = {
          ...con,
          connectionId: row.connectionId,
          functionId: row.functionId,
          status: row.status,
        };
        const labelsStr = Object.entries(labels)
          .map(([key, value]) => `${key}="${value ? value.replaceAll(/"/g, '\\"') : ""}"`)
          .join(",");
        res.write(`jitsu_connection_statuses{${labelsStr}} ${row.eventsCount}\n`);
      });
    } catch (e) {
      res.writeHead(500, {
        "Content-Type": "text/plain",
      });
      log.atError().withCause(e).log(`Failed to fetch metrics for workspace ${workspaceId}`);
      res.write("Failed to fetch metrics");
    } finally {
      res.end();
    }
  })
  .toNextApiHandler();
