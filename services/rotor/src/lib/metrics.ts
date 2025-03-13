import { getLog, isTruish, requireDefined, stopwatch } from "juava";
import { FunctionExecLog, FunctionExecRes, MetricsMeta, RotorMetrics } from "@jitsu/core-functions";

import omit from "lodash/omit";
import type { Producer } from "kafkajs";
import { getCompressionType } from "./rotor";
import { Readable } from "stream";
import { Counter } from "prom-client";
import { createClient } from "@clickhouse/client";

const log = getLog("metrics");
const bulkerBase = requireDefined(process.env.BULKER_URL, "env BULKER_URL is not defined");
const bulkerAuthKey = requireDefined(process.env.BULKER_AUTH_KEY, "env BULKER_AUTH_KEY is not defined");
const metricsDestinationId = process.env.METRICS_DESTINATION_ID;
const billingMetricsTable = "active_incoming";
const metricsTable = "metrics";

const max_batch_size = 10000;
const flush_interval_ms = 60000;

const _Timestamp = 0;
const _MessageId = 1;
const _WorkspaceId = 2;
const _StreamId = 3;
const _ConnectionId = 4;
const _FunctionId = 5;
const _DestinationId = 6;
const _Status = 7;
const _Count = 8;
const _EventIndex = 9;

type MetricsEvent = [Date, string, string, string, string, string, string, string, number, number];

export const DummyMetrics: RotorMetrics = {
  logMetrics: () => {},
  storeStatus: () => {},
  close: () => {},
};

export function createMetrics(
  producer?: Producer,
  storeCounter?: Counter<"namespace" | "operation" | "status">
): RotorMetrics {
  const buffer: MetricsEvent[] = [];
  const metricsSchema = process.env.CLICKHOUSE_METRICS_SCHEMA || process.env.CLICKHOUSE_DATABASE || "newjitsu_metrics";

  const clickhouse = createClient({
    url: clickhouseHost(),
    username: process.env.CLICKHOUSE_USERNAME || "default",
    password: requireDefined(process.env.CLICKHOUSE_PASSWORD, `env CLICKHOUSE_PASSWORD is not defined`),
    clickhouse_settings: {
      async_insert: 1,
      wait_for_async_insert: 0,
      async_insert_busy_timeout_ms: 30000,
      async_insert_busy_timeout_max_ms: 30000,
      date_time_input_format: "best_effort",
    },
  });

  const flushBillingMetrics = async (buf: MetricsEvent[]) => {
    if (producer) {
      const asyncWrite = async () => {
        return producer.send({
          topic: `in.id.metrics.m.batch.t.${billingMetricsTable}`,
          compression: getCompressionType(),
          messages: buf
            .filter(m => m[_FunctionId].startsWith("builtin.destination.") && m[_Status] !== "dropped")
            .map(m => {
              const d = new Date(m[_Timestamp]);
              d.setMilliseconds(0);
              d.setSeconds(0);
              d.setMinutes(0);
              const key = m[_MessageId] + "_" + m[_EventIndex] + "_" + (m[_Timestamp].getTime() - d.getTime());
              return {
                key: key,
                value: JSON.stringify({
                  timestamp: d,
                  workspaceId: m[_WorkspaceId],
                  // to count active events use composed key: messageId_eventIndex_receivedAt
                  messageId: key,
                }),
              };
            }),
        });
      };
      return asyncWrite().catch(e => {
        log.atError().withCause(e).log(`Failed to flush billing metrics`);
      });
    } else {
      const billingStream = new Readable({ objectMode: true });
      const billingResponse = clickhouse.insert({
        table: metricsSchema + "." + billingMetricsTable,
        format: "JSONCompactEachRow",
        values: billingStream,
      });

      const asyncWrite = async () => {
        for (let i = 0; i < buf.length; i++) {
          const m = buf[i];
          if (m[_FunctionId].startsWith("builtin.destination.") && m[_Status] !== "dropped") {
            const d = new Date(m[_Timestamp]);
            d.setMilliseconds(0);
            d.setSeconds(0);
            d.setMinutes(0);
            const key = m[_MessageId] + "_" + m[_EventIndex] + "_" + (m[_Timestamp].getTime() - d.getTime());
            billingStream.push([d, m[_WorkspaceId], key]);
          }
        }
        billingStream.push(null);
        return billingResponse;
      };
      return asyncWrite()
        .then(async r => {
          if (!r.executed) {
            log.atError().log(`Failed to insert ${buf.length} billing metrics: ${JSON.stringify(r)}`);
          }
        })
        .catch(e => {
          log.atError().withCause(e).log(`Failed to insert billing metrics.`);
        });
    }
  };

  const flush = async (buf: MetricsEvent[]) => {
    const promises: Promise<any>[] = [flushBillingMetrics(buf)];

    const metricsStream = new Readable({ objectMode: true });
    const metricsResponse = clickhouse.insert({
      table: metricsSchema + "." + metricsTable,
      format: "JSONCompactEachRow",
      values: metricsStream,
    });
    const asyncWrite = async () => {
      for (let i = 0; i < buf.length; i++) {
        metricsStream.push(buf[i]);
      }
      metricsStream.push(null);
      return metricsResponse;
    };

    promises.push(
      asyncWrite()
        .then(async r => {
          if (!r.executed) {
            log.atError().log(`Failed to insert ${buf.length} records: ${JSON.stringify(r)}`);
          }
        })
        .catch(e => {
          log.atError().withCause(e).log(`Failed to flush metrics events`);
        })
    );

    await Promise.all(promises);
  };

  const interval = setInterval(async () => {
    const length = buffer.length;
    if (length > 0) {
      const sw = stopwatch();
      try {
        const copy = buffer.slice();
        buffer.length = 0;
        await flush(copy);
        log.atDebug().log(`Periodic flushing ${copy.length} metrics events took ${sw.elapsedPretty()}`);
      } catch (e) {
        log.atError().withCause(e).log(`Failed to flush metrics`);
      }
    }
  }, flush_interval_ms);

  return {
    logMetrics: (execLog: FunctionExecLog) => {
      if (!metricsDestinationId) {
        return;
      }

      for (let i = 0; i < execLog.length; i++) {
        const el = execLog[i];
        if (!el.metricsMeta) {
          continue;
        }
        const status = ((el: FunctionExecRes) => {
          let prefix = el.functionId.startsWith("builtin.destination.")
            ? ""
            : el.functionId.startsWith("builtin.transformation.")
            ? "builtin_function_"
            : "function_";
          let status = "success";
          if (el.error) {
            if (el.metricsMeta?.retries) {
              prefix = prefix + "retry_";
            }
            status = "error";
          } else if (el.dropped) {
            prefix = "";
            status = "dropped";
          } else if (el.functionId === "builtin.destination.bulker") {
            status = "processed";
          }
          return prefix + status;
        })(el);
        buffer.push([
          el.receivedAt || new Date(),
          el.metricsMeta.messageId,
          el.metricsMeta.workspaceId,
          el.metricsMeta.streamId,
          el.metricsMeta.connectionId,
          el.functionId,
          el.metricsMeta.destinationId,
          status,
          1,
          el.eventIndex,
        ]);
      }
      if (buffer.length >= max_batch_size) {
        const sw = stopwatch();
        const copy = buffer.slice();
        buffer.length = 0;
        setImmediate(async () =>
          flush(copy)
            .then(() => log.atDebug().log(`Flushed ${copy.length} metrics events. Took: ${sw.elapsedPretty()}`))
            .catch(e => {
              log.atError().withCause(e).log(`Failed to flush metrics`);
            })
        );
      }
    },
    storeStatus: (namespace: string, operation: string, status: string) => {
      if (storeCounter) {
        storeCounter.labels(namespace, operation, status).inc();
      }
    },
    close: () => {
      clearInterval(interval);
      clickhouse.close();
    },
  };
}

function clickhouseHost() {
  if (process.env.CLICKHOUSE_URL) {
    return process.env.CLICKHOUSE_URL;
  }
  return `${isTruish(process.env.CLICKHOUSE_SSL) ? "https://" : "http://"}${requireDefined(
    process.env.CLICKHOUSE_HOST,
    "env CLICKHOUSE_HOST is not defined"
  )}`;
}
