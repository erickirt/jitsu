import { ProfileBuilder } from "@jitsu/core-functions";
import { kafkaAdmin, kafkaCredentials, kafkaSettings, topicName } from "./kafka";
import PQueue from "p-queue";
import { getLog, parseNumber } from "juava";
import { KafkaJS, TopicPartitionOffsetSpec, OffsetSpec } from "@confluentinc/kafka-javascript";
import { db, ProfileBuilderQueueInfo } from "./db";
import { metricsInterval } from "../builder";
import { promQueueProcessed, promQueueSize } from "./metrics";
const concurrency = parseNumber(process.env.CONCURRENCY, 10);
const instancesCount = parseNumber(process.env.INSTANCES_COUNT, 1);

const log = getLog("priority-consumer");

interface PriorityConsumer {
  start(): Promise<void>;
  close(): Promise<void>;
}

type ProfileId = string;
type RateLimitWindow = {
  activated: boolean;
};

export function createPriorityConsumer(
  profileBuilder: ProfileBuilder,
  priorityLevels: number,
  profileTask: (profileId: string, priority: number) => () => Promise<void>
): PriorityConsumer {
  let consumers: KafkaJS.Consumer[] = [];
  const rateLimitWindows: Record<ProfileId, RateLimitWindow> = {};
  const queue = new PQueue({ concurrency });

  const onSizeLessThan = async (limit: number) => {
    if (queue.size < limit) {
      return;
    }
    return new Promise<void>(resolve => {
      const listener = () => {
        if (queue.size < limit) {
          queue.removeListener("next", listener);
          resolve();
        }
      };
      queue.on("next", listener);
    });
  };

  const closeQueue = async () => {
    log.atInfo().log("Closing queue...");
    await queue.onIdle();
  };

  async function rateLimitedExecution(
    key: string,
    task: () => Promise<void>,
    intervalMs: number = 1000 * 30
  ): Promise<void> {
    const rateLimitWindow = rateLimitWindows[key];
    // First event for key or event after a long pause (more than intervalMs)
    if (!rateLimitWindow) {
      const newRateLimitWindow: RateLimitWindow = {
        activated: false,
      };
      rateLimitWindows[key] = newRateLimitWindow;
      let timeout: NodeJS.Timeout;
      // The newRateLimitWindow collapses all events received for a key in the last intervalMs into the one
      // timer will execute the one in that case
      timeout = setTimeout(() => {
        if (!newRateLimitWindow.activated) {
          // No events received in the last intervalMs. Removing the rate limit window
          log.atDebug().log(`Deactivating rate limit window for ${key}`);
          clearTimeout(timeout);
          delete rateLimitWindows[key];
        } else {
          // reset the timer and newRateLimitWindow state
          timeout.refresh();
          newRateLimitWindow.activated = false;
          // execute the task
          task();
        }
      }, intervalMs);
      // First event for key or event after a long pause (more than intervalMs). Execute the task right away
      await task();
    } else if (!rateLimitWindow.activated) {
      // Event received for key during the intervalMs. Activate the rate limit window
      // Task will be executed after interval ends
      log.atDebug().log(`Activating rate limit window for ${key}`);
      rateLimitWindow.activated = true;
    } else {
      log.atDebug().log(`Rate limit window for ${key} is already activated`);
    }
  }

  return {
    async start(): Promise<void> {
      for (let i = 0; i < priorityLevels; i++) {
        const sizeCap = concurrency * (1 - i / 10);
        const topic = topicName(profileBuilder.id, i);
        kafkaAdmin.createTopic(
          {
            topic,
            num_partitions: instancesCount,
            replication_factor: kafkaSettings.topicReplicationFactor,
            config: {
              "cleanup.policy": "compact,delete",
              "retention.ms": kafkaSettings.topicRetentionMs.toString(),
              "segment.ms": kafkaSettings.topicSegmentMs.toString(),
            },
          },
          e => {
            if (!e) {
              log.atInfo().log(`Topic ${topic} created`);
            } else if (e.code !== 36) {
              log
                .atError()
                .withCause(e)
                .log(`Failed to create topic ${topic} : ${JSON.stringify(e)}`);
            } else {
              log.atDebug().log(`Topic ${topic} already exists`);
            }
          }
        );

        const consumer = new KafkaJS.Kafka({}).consumer({
          "bootstrap.servers": kafkaCredentials.brokers.join(","),
          "group.id": "profile-builder-" + profileBuilder.id,
        });

        await consumer.connect();
        await consumer.subscribe({ topics: [topic] });

        consumer.run({
          eachMessage: async ({ message }) => {
            const profileId = message.key?.toString();
            if (!profileId) {
              log.atError().log("Message without key");
              return;
            }
            await onSizeLessThan(sizeCap);
            queue
              .add(
                async () => {
                  await rateLimitedExecution(profileId, profileTask(profileId, i), 1000 * 30);
                },
                { priority: priorityLevels - i }
              )
              .catch(e => {
                log.atError().withCause(e).log("Failed to process message");
              });
          },
        });

        consumers.push(consumer);
      }
    },

    async close(): Promise<void> {
      for (const consumer of consumers) {
        await consumer.disconnect();
      }
      await closeQueue();
    },
  };
}

export type TopicsReport = Record<
  string,
  Record<number, { highOffset: number; offset: number; previousOffset?: number }>
>;

export async function reportQueueSize(
  profileBuilder: ProfileBuilder,
  priorityLevels: number,
  previousOffsets?: TopicsReport
): Promise<TopicsReport> {
  log.atDebug().log(`Reporting queue size for ${profileBuilder.id}`);
  const topics: TopicsReport = {};
  for (let i = 0; i < priorityLevels; i++) {
    const topic = topicName(profileBuilder.id, i);
    topics[topic] = {};
  }
  const { promise, resolve, reject } = createDeferred();

  kafkaAdmin.listConsumerGroupOffsets([{ groupId: "profile-builder-" + profileBuilder.id }], undefined, (e, data) => {
    if (e) {
      log
        .atError()
        .withCause(e)
        .log(`Failed to describe topics ${JSON.stringify(topics)}`);
      reject(e);
      return;
    }
    for (const group of data) {
      const partitions = group.partitions;
      for (const partition of partitions) {
        if (partition.error) {
          log
            .atError()
            .log(`Failed to get partition ${partition.topic}:${partition.partition} offset: ${partition.error}`);
          reject(partition.error);
          return;
        }
        const topic = topics[partition.topic];
        if (!topic) {
          continue;
        }
        const previousOffset = previousOffsets?.[partition.topic]?.[partition.partition]?.offset;
        const partitionInfo = topic[partition.partition];
        if (!partitionInfo) {
          topic[partition.partition] = { offset: partition.offset, highOffset: 0, previousOffset };
        } else {
          partitionInfo.offset = partition.offset;
          partitionInfo.previousOffset = previousOffset;
        }
      }
    }
    resolve();
  });
  await promise;

  const { promise: promise2, resolve: resolve2, reject: reject2 } = createDeferred();

  kafkaAdmin.describeTopics(Object.keys(topics), undefined, (e, data) => {
    if (e) {
      log
        .atError()
        .withCause(e)
        .log(`Failed to describe topics ${JSON.stringify(topics)}`);
      reject2(e);
      return;
    }
    const specs: TopicPartitionOffsetSpec[] = [];
    for (const topic of data) {
      if (topic.error) {
        log.atError().log(`Failed to describe topic ${topic.name} : ${topic.error}`);
        reject2(topic.error);
        return;
      }
      const partitions = topic.partitions;
      for (const partition of partitions) {
        specs.push({
          topic: topic.name,
          partition: partition.partition,
          offset: OffsetSpec.LATEST,
        });
      }
    }
    kafkaAdmin.listOffsets(specs, undefined, (e, data) => {
      if (e) {
        log
          .atError()
          .withCause(e)
          .log(`Failed to list offsets ${JSON.stringify(topics)}`);
        reject2(e);
        return;
      }
      for (const partition of data) {
        const topic = topics[partition.topic];
        const partitionInfo = topic[partition.partition];
        if (!partitionInfo) {
          topic[partition.partition] = { highOffset: partition.offset, offset: 0 };
        } else {
          partitionInfo.highOffset = partition.offset;
        }
      }
      resolve2();
    });
  });

  await promise2;

  const queues: ProfileBuilderQueueInfo["queues"] = {};
  for (let i = 0; i < priorityLevels; i++) {
    const name = topicName(profileBuilder.id, i);
    const topic = topics[name];
    const size = Object.values(topic).reduce((acc, partition) => {
      if (partition.highOffset) {
        return acc + (partition.highOffset - partition.offset);
      }
      return acc;
    }, 0);
    const processed = Object.values(topic).reduce((acc, partition) => {
      if (partition.previousOffset) {
        return acc + (partition.offset - partition.previousOffset);
      }
      return acc;
    }, 0);
    promQueueSize.labels({ builderId: profileBuilder.id, priority: i }).set(size);
    promQueueProcessed.labels({ builderId: profileBuilder.id, priority: i }).inc(processed);
    queues[i] = {
      priority: i,
      size,
      processed,
    };
  }
  log.atDebug().log(`Queue size: ${JSON.stringify(queues)}`);
  await db.pgHelper().updateProfileBuilderQueuesInfo(profileBuilder.id, {
    timestamp: new Date(),
    intervalSec: metricsInterval / 1000,
    queues,
  });
  return topics;
}

function createDeferred() {
  let resolve, reject;

  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}
