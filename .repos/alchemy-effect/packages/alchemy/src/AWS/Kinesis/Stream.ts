// required to avoid this error in consumers: "The inferred type of 'Records' cannot be named without a reference to '../../@distilled.cloud/aws/node_modules/@types/aws-lambda'. This is likely not portable. A type annotation is necessary.ts(2742)"
export type * as lambda from "aws-lambda";

import { Region } from "@distilled.cloud/aws/Region";
import * as kinesis from "@distilled.cloud/aws/kinesis";
import type * as lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  type Tags,
} from "../../Tags.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { RegionID } from "../Region.ts";

export type StreamRecord = lambda.KinesisStreamRecord;

export type StreamEvent = lambda.KinesisStreamEvent;

export type StreamName = string;
export type StreamArn =
  `arn:aws:kinesis:${RegionID}:${AccountID}:stream/${StreamName}`;

export type StreamStatus = "CREATING" | "DELETING" | "ACTIVE" | "UPDATING";

export type StreamMode = "PROVISIONED" | "ON_DEMAND";

export type EncryptionType = "NONE" | "KMS";

export type WarmThroughput = {
  targetMiBps?: number;
  currentMiBps?: number;
};

export type StreamProps = {
  /**
   * Name of the stream.
   * @default ${app}-${stage}-${id}
   */
  streamName?: string;
  /**
   * The capacity mode of the data stream.
   * - PROVISIONED: You specify the number of shards for the data stream.
   * - ON_DEMAND: AWS manages the shards for the data stream.
   * @default "ON_DEMAND"
   */
  streamMode?: StreamMode;
  /**
   * The number of shards that the stream will use when in PROVISIONED mode.
   * Required when `streamMode` is `"PROVISIONED"`.
   */
  shardCount?: number;
  /**
   * The number of hours that records remain accessible in the stream.
   * Valid values range from 24 to 8760.
   * @default 24
   */
  retentionPeriodHours?: number;
  /**
   * If set to true, server-side encryption is enabled on the stream.
   * Uses the AWS managed CMK for Kinesis (`alias/aws/kinesis`) when `kmsKeyId`
   * is omitted.
   * @default false
   */
  encryption?: boolean;
  /**
   * The AWS KMS key to use when encryption is enabled.
   */
  kmsKeyId?: string;
  /**
   * A list of shard-level CloudWatch metrics to enable for the stream.
   */
  shardLevelMetrics?: ShardLevelMetric[];
  /**
   * Pre-provisioned warm throughput for on-demand streams, in MiBps.
   */
  warmThroughputMiBps?: number;
  /**
   * Maximum size of a single record, in KiB.
   */
  maxRecordSizeInKiB?: number;
  /**
   * Resource policy attached to the stream.
   */
  resourcePolicy?: string;
  /**
   * Tags to associate with the stream.
   */
  tags?: Record<string, string>;
};

export interface Stream extends Resource<
  "AWS.Kinesis.Stream",
  StreamProps,
  {
    /**
     * The stream's physical name.
     */
    streamName: StreamName;
    /**
     * ARN of the stream.
     */
    streamArn: StreamArn;
    /**
     * Provider-assigned unique identifier for the stream, when returned by AWS.
     */
    streamId: string | undefined;
    /**
     * Current lifecycle status of the stream.
     */
    streamStatus: StreamStatus;
    /**
     * Current capacity mode of the stream.
     */
    streamMode: StreamMode;
    /**
     * Number of hours that records remain accessible in the stream.
     */
    retentionPeriodHours: number;
    /**
     * Current server-side encryption mode.
     */
    encryptionType: EncryptionType;
    /**
     * KMS key ID backing stream encryption, when encryption is enabled with KMS.
     */
    kmsKeyId: string | undefined;
    /**
     * Number of open shards currently reported by the stream summary.
     */
    openShardCount: number | undefined;
    /**
     * Number of registered consumers currently attached to the stream.
     */
    consumerCount: number | undefined;
    /**
     * Enabled shard-level CloudWatch metrics for the stream.
     */
    shardLevelMetrics: ShardLevelMetric[];
    /**
     * Current and target warm throughput settings for on-demand streams, when available.
     */
    warmThroughput: WarmThroughput | undefined;
    /**
     * Maximum record size, in KiB, that the stream accepts.
     */
    maxRecordSizeInKiB: number | undefined;
    /**
     * Current resource policy attached to the stream, if one is configured.
     */
    resourcePolicy: string | undefined;
    /**
     * Current tags reported for the stream.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Kinesis Data Stream.
 *
 * `Stream` owns the stream's lifecycle and mutable control-plane configuration,
 * including retention, encryption, monitoring, warm throughput, record size, tags,
 * and stream resource policy. A stream name is auto-generated from the app,
 * stage, and logical ID unless you provide one explicitly.
 *
 * @section Creating Streams
 * @example On-Demand Stream
 * ```typescript
 * import * as Kinesis from "alchemy/AWS/Kinesis";
 *
 * const stream = yield* Kinesis.Stream("OrdersStream");
 * ```
 *
 * @example Provisioned Stream
 * ```typescript
 * const stream = yield* Kinesis.Stream("AnalyticsStream", {
 *   streamMode: "PROVISIONED",
 *   shardCount: 2,
 *   retentionPeriodHours: 48,
 * });
 * ```
 *
 * @example Encrypted Stream
 * ```typescript
 * const stream = yield* Kinesis.Stream("SecureStream", {
 *   encryption: true,
 *   kmsKeyId: "alias/my-key",
 * });
 * ```
 *
 * @section Runtime Producers
 * Bind producer operations in the init phase and use them in runtime
 * handlers.
 *
 * @example Put a record from a handler
 * ```typescript
 * // init
 * const putRecord = yield* Kinesis.PutRecord.bind(stream);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* putRecord({
 *       PartitionKey: "order-123",
 *       Data: new TextEncoder().encode(JSON.stringify({ orderId: "123" })),
 *     });
 *     return HttpServerResponse.text("Sent");
 *   }),
 * };
 * ```
 *
 * @section Event Sources
 * Process records from a Kinesis stream using a Lambda event source
 * mapping.
 *
 * @example Process stream records
 * ```typescript
 * // init
 * yield* Kinesis.records(stream).process(
 *   Effect.fn(function* (record) {
 *     const data = new TextDecoder().decode(record.data);
 *     yield* Effect.log(`Received: ${data}`);
 *   }),
 * );
 * ```
 */
export const Stream = Resource<Stream>("AWS.Kinesis.Stream");

export type ShardLevelMetric =
  | "IncomingBytes"
  | "IncomingRecords"
  | "OutgoingBytes"
  | "OutgoingRecords"
  | "WriteProvisionedThroughputExceeded"
  | "ReadProvisionedThroughputExceeded"
  | "IteratorAgeMilliseconds"
  | "ALL";

const defaultStreamMode = "ON_DEMAND" as const;
const defaultRetentionPeriodHours = 24;
const defaultEncryptionType = "NONE" as const;

const createStreamName = (
  id: string,
  props: {
    streamName?: string | undefined;
  },
) =>
  Effect.gen(function* () {
    if (props.streamName) {
      return props.streamName;
    }
    return yield* createPhysicalName({
      id,
      maxLength: 128,
    });
  });

const getStreamMode = (props: StreamProps): kinesis.StreamModeDetails => ({
  StreamMode: props.streamMode ?? defaultStreamMode,
});

const assertProvisionedProps = (props: StreamProps) =>
  props.streamMode === "PROVISIONED" && props.shardCount === undefined
    ? Effect.fail(
        new Error(`streamMode "PROVISIONED" requires shardCount to be set`),
      )
    : Effect.void;

const toTagRecord = (
  tags: Array<{ Key: string; Value?: string }> | undefined,
) =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

const toWarmThroughput = (
  warmThroughput: kinesis.WarmThroughputObject | undefined,
): WarmThroughput | undefined =>
  warmThroughput
    ? {
        targetMiBps: warmThroughput.TargetMiBps,
        currentMiBps: warmThroughput.CurrentMiBps,
      }
    : undefined;

const toShardLevelMetrics = (
  monitoring: kinesis.EnhancedMetrics[] | undefined,
): ShardLevelMetric[] =>
  [
    ...new Set(
      (monitoring ?? []).flatMap((metric) => metric.ShardLevelMetrics ?? []),
    ),
  ] as ShardLevelMetric[];

const toAttrs = ({
  summary,
  tags,
  resourcePolicy,
}: {
  summary: kinesis.StreamDescriptionSummary;
  tags: Record<string, string>;
  resourcePolicy?: string;
}): Stream["Attributes"] => ({
  streamName: summary.StreamName,
  streamArn: summary.StreamARN as StreamArn,
  streamId: summary.StreamId,
  streamStatus: summary.StreamStatus as StreamStatus,
  streamMode: (summary.StreamModeDetails?.StreamMode ??
    defaultStreamMode) as StreamMode,
  retentionPeriodHours:
    summary.RetentionPeriodHours ?? defaultRetentionPeriodHours,
  encryptionType: (summary.EncryptionType ??
    defaultEncryptionType) as EncryptionType,
  kmsKeyId: summary.KeyId,
  openShardCount: summary.OpenShardCount,
  consumerCount: summary.ConsumerCount,
  shardLevelMetrics: toShardLevelMetrics(summary.EnhancedMonitoring),
  warmThroughput: toWarmThroughput(summary.WarmThroughput),
  maxRecordSizeInKiB: summary.MaxRecordSizeInKiB,
  resourcePolicy,
  tags,
});

const readStream = Effect.fn(function* ({
  streamName,
  streamArn,
}: {
  streamName?: string;
  streamArn?: string;
}) {
  const response = yield* kinesis
    .describeStreamSummary({
      StreamName: streamName,
      StreamARN: streamArn,
    })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

  if (!response) {
    return undefined;
  }

  const summary = response.StreamDescriptionSummary;
  const tagsResponse = yield* kinesis.listTagsForResource({
    ResourceARN: summary.StreamARN,
  });
  const policyResponse = yield* kinesis
    .getResourcePolicy({
      ResourceARN: summary.StreamARN,
    })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

  return toAttrs({
    summary,
    tags: toTagRecord(tagsResponse.Tags),
    // Treat an empty policy string as "no policy attached" so the
    // sync step doesn't try to delete a phantom policy.
    resourcePolicy: policyResponse?.Policy ? policyResponse.Policy : undefined,
  });
});

const waitForStreamActive = (streamName: string) =>
  Effect.gen(function* () {
    yield* Effect.sleep("2 seconds");
    const { StreamDescriptionSummary } = yield* kinesis.describeStreamSummary({
      StreamName: streamName,
    });
    if (StreamDescriptionSummary.StreamStatus !== "ACTIVE") {
      return yield* Effect.fail({ _tag: "StreamNotActive" as const });
    }
    return StreamDescriptionSummary;
  }).pipe(
    Effect.retry({
      while: (e: { _tag: string }) =>
        e._tag === "StreamNotActive" || e._tag === "ParseError",
      schedule: Schedule.exponential(500).pipe(
        Schedule.both(Schedule.recurs(60)),
      ),
    }),
  );

const waitForStreamDeleted = (streamName: string) =>
  Effect.gen(function* () {
    yield* kinesis.describeStreamSummary({
      StreamName: streamName,
    });
    return yield* Effect.fail({ _tag: "StreamStillExists" as const });
  }).pipe(
    Effect.retry({
      while: (e: { _tag: string }) =>
        e._tag === "StreamStillExists" || e._tag === "ParseError",
      schedule: Schedule.exponential(500).pipe(
        Schedule.both(Schedule.recurs(60)),
      ),
    }),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );

export const StreamProvider = () =>
  Provider.effect(
    Stream,
    Effect.gen(function* () {
      const region = yield* Region;
      const { accountId } = yield* AWSEnvironment;

      return {
        stables: ["streamName", "streamArn"],
        read: Effect.fn(function* ({ id, olds, output }) {
          const streamName =
            output?.streamName ?? (yield* createStreamName(id, olds ?? {}));
          const state = yield* readStream({
            streamName,
            streamArn: output?.streamArn,
          });
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.tags as Tags))
            ? state
            : Unowned(state);
        }),
        diff: Effect.fn(function* ({ id, news = {}, olds = {} }) {
          if (!isResolved(news)) return;
          const oldStreamName = yield* createStreamName(id, olds);
          const newStreamName = yield* createStreamName(id, news);
          if (oldStreamName !== newStreamName) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          yield* assertProvisionedProps(news);

          const streamName =
            output?.streamName ?? (yield* createStreamName(id, news));
          const streamArn =
            `arn:aws:kinesis:${region}:${accountId}:stream/${streamName}` as const;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — fetch live cloud state. `output` is treated as a cache
          // for the physical name only; the stream's actual existence and
          // configuration are fetched fresh so the reconciler converges
          // regardless of drift, adoption, or a partially-completed prior
          // run.
          let state = yield* readStream({ streamName, streamArn });

          // Ensure — create the stream if it's missing. Tolerate
          // `ResourceInUseException` as a race with a peer reconciler:
          // re-read and continue with the sync path. Retry transient
          // `LimitExceededException`.
          if (state === undefined) {
            yield* kinesis
              .createStream({
                StreamName: streamName,
                ShardCount:
                  news.streamMode === "PROVISIONED"
                    ? news.shardCount
                    : undefined,
                StreamModeDetails: getStreamMode(news),
                Tags: desiredTags,
                WarmThroughputMiBps: news.warmThroughputMiBps,
                MaxRecordSizeInKiB: news.maxRecordSizeInKiB,
              })
              .pipe(
                Effect.catchTag("ResourceInUseException", () => Effect.void),
                Effect.retry({
                  while: (e: any) => e._tag === "LimitExceededException",
                  schedule: Schedule.exponential(1000),
                }),
              );

            yield* session.note(`Creating stream ${streamName}...`);
            yield* waitForStreamActive(streamName);

            state = yield* readStream({ streamName, streamArn });
            if (state === undefined) {
              return yield* Effect.fail(
                new Error(`failed to read created stream ${streamName}`),
              );
            }
          }

          // Sync stream mode — observed ↔ desired.
          const desiredMode = news.streamMode ?? defaultStreamMode;
          if (state.streamMode !== desiredMode) {
            yield* kinesis.updateStreamMode({
              StreamARN: streamArn,
              StreamModeDetails: getStreamMode(news),
              WarmThroughputMiBps:
                desiredMode === "ON_DEMAND"
                  ? news.warmThroughputMiBps
                  : undefined,
            });
            yield* waitForStreamActive(streamName);
            yield* session.note(`Updated stream mode to ${desiredMode}`);
            state = yield* readStream({ streamName, streamArn });
            if (state === undefined) {
              return yield* Effect.fail(
                new Error(`failed to re-read stream ${streamName}`),
              );
            }
          }

          // Sync shard count — only meaningful in PROVISIONED mode.
          if (
            desiredMode === "PROVISIONED" &&
            news.shardCount !== undefined &&
            state.openShardCount !== news.shardCount
          ) {
            yield* kinesis.updateShardCount({
              StreamName: streamName,
              TargetShardCount: news.shardCount,
              ScalingType: "UNIFORM_SCALING",
            });
            yield* waitForStreamActive(streamName);
            yield* session.note(`Updated shard count to ${news.shardCount}`);
          }

          // Sync retention period — observed ↔ desired.
          const desiredRetention =
            news.retentionPeriodHours ?? defaultRetentionPeriodHours;
          if (state.retentionPeriodHours !== desiredRetention) {
            if (desiredRetention > state.retentionPeriodHours) {
              yield* kinesis.increaseStreamRetentionPeriod({
                StreamName: streamName,
                RetentionPeriodHours: desiredRetention,
              });
            } else {
              yield* kinesis.decreaseStreamRetentionPeriod({
                StreamName: streamName,
                RetentionPeriodHours: desiredRetention,
              });
            }
            yield* waitForStreamActive(streamName);
            yield* session.note(
              `Updated retention period to ${desiredRetention} hours`,
            );
          }

          // Sync encryption — observed ↔ desired.
          const desiredEncryption = news.encryption ?? false;
          const desiredKmsKey = news.kmsKeyId ?? "alias/aws/kinesis";
          const observedEncryption = state.encryptionType === "KMS";
          if (!observedEncryption && desiredEncryption) {
            yield* kinesis.startStreamEncryption({
              StreamName: streamName,
              EncryptionType: "KMS",
              KeyId: desiredKmsKey,
            });
            yield* waitForStreamActive(streamName);
            yield* session.note("Enabled encryption");
          } else if (observedEncryption && !desiredEncryption) {
            yield* kinesis.stopStreamEncryption({
              StreamName: streamName,
              EncryptionType: "KMS",
              KeyId: state.kmsKeyId ?? desiredKmsKey,
            });
            yield* waitForStreamActive(streamName);
            yield* session.note("Disabled encryption");
          } else if (
            observedEncryption &&
            desiredEncryption &&
            news.kmsKeyId !== undefined &&
            state.kmsKeyId !== news.kmsKeyId
          ) {
            yield* kinesis.startStreamEncryption({
              StreamName: streamName,
              EncryptionType: "KMS",
              KeyId: news.kmsKeyId,
            });
            yield* waitForStreamActive(streamName);
            yield* session.note("Updated KMS key");
          }

          // Sync shard-level metrics — observed ↔ desired.
          const observedMetrics = new Set(state.shardLevelMetrics);
          const desiredMetrics = new Set(news.shardLevelMetrics ?? []);
          const metricsToEnable = (news.shardLevelMetrics ?? []).filter(
            (metric) => !observedMetrics.has(metric),
          );
          const metricsToDisable = state.shardLevelMetrics.filter(
            (metric) => !desiredMetrics.has(metric),
          );

          if (metricsToDisable.length > 0) {
            yield* kinesis.disableEnhancedMonitoring({
              StreamName: streamName,
              ShardLevelMetrics: metricsToDisable,
            });
            yield* waitForStreamActive(streamName);
            yield* session.note(
              `Disabled metrics: ${metricsToDisable.join(", ")}`,
            );
          }

          if (metricsToEnable.length > 0) {
            yield* kinesis.enableEnhancedMonitoring({
              StreamName: streamName,
              ShardLevelMetrics: metricsToEnable,
            });
            yield* waitForStreamActive(streamName);
            yield* session.note(
              `Enabled metrics: ${metricsToEnable.join(", ")}`,
            );
          }

          // Sync warm throughput — only meaningful in ON_DEMAND mode.
          if (
            desiredMode === "ON_DEMAND" &&
            news.warmThroughputMiBps !== undefined &&
            state.warmThroughput?.targetMiBps !== news.warmThroughputMiBps
          ) {
            yield* kinesis.updateStreamWarmThroughput({
              StreamARN: streamArn,
              WarmThroughputMiBps: news.warmThroughputMiBps,
            });
            yield* waitForStreamActive(streamName);
            yield* session.note(
              `Updated warm throughput to ${news.warmThroughputMiBps} MiBps`,
            );
          }

          // Sync max record size — observed ↔ desired.
          if (
            news.maxRecordSizeInKiB !== undefined &&
            state.maxRecordSizeInKiB !== news.maxRecordSizeInKiB
          ) {
            yield* kinesis.updateMaxRecordSize({
              StreamARN: streamArn,
              MaxRecordSizeInKiB: news.maxRecordSizeInKiB,
            });
            yield* waitForStreamActive(streamName);
            yield* session.note(
              `Updated max record size to ${news.maxRecordSizeInKiB} KiB`,
            );
          }

          // Sync tags — diff observed cloud tags against desired. Adoption
          // may bring us a stream that already has its own tag set; diffing
          // against `state.tags` (fetched fresh) lets the reconciler
          // converge ownership without fighting whatever was there before.
          const { removed, upsert } = diffTags(state.tags, desiredTags);

          if (removed.length > 0) {
            yield* kinesis.removeTagsFromStream({
              StreamName: streamName,
              TagKeys: removed,
            });
          }

          if (upsert.length > 0) {
            const tagsToAdd: Record<string, string> = {};
            for (const { Key, Value } of upsert) {
              tagsToAdd[Key] = Value;
            }
            yield* kinesis.addTagsToStream({
              StreamName: streamName,
              Tags: tagsToAdd,
            });
          }

          // Sync resource policy — observed ↔ desired. Tolerate the
          // race where the cloud's policy was already removed (delete
          // fails with `ResourceNotFoundException`) or where another
          // reconcile already wrote the same policy.
          if (state.resourcePolicy !== news.resourcePolicy) {
            if (news.resourcePolicy) {
              yield* kinesis.putResourcePolicy({
                ResourceARN: streamArn,
                Policy: news.resourcePolicy,
              });
            } else if (state.resourcePolicy) {
              yield* kinesis
                .deleteResourcePolicy({
                  ResourceARN: streamArn,
                })
                .pipe(
                  Effect.catchTag(
                    "ResourceNotFoundException",
                    () => Effect.void,
                  ),
                );
            }
          }

          yield* session.note(streamArn);

          // Re-read final state so the returned attributes reflect what's
          // actually in the cloud after all sync steps.
          const final = yield* readStream({ streamName, streamArn });
          if (!final) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled stream ${streamName}`),
            );
          }
          return final;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* kinesis
            .deleteStream({
              StreamName: output.streamName,
              EnforceConsumerDeletion: true,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );

          yield* waitForStreamDeleted(output.streamName);
        }),
      };
    }),
  );
