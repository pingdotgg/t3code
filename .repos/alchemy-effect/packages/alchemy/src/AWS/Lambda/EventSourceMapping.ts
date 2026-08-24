import * as lambda from "@distilled.cloud/aws/lambda";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export type StartingPosition = "TRIM_HORIZON" | "LATEST" | "AT_TIMESTAMP";

export type FunctionResponseType = "ReportBatchItemFailures";

export interface EventSourceMappingProps {
  /**
   * The name or ARN of the Lambda function to invoke.
   */
  functionName: string;
  /**
   * The ARN of the event source (SQS queue, Kinesis stream, DynamoDB stream, etc.).
   */
  eventSourceArn: string;
  /**
   * The maximum number of records in each batch that Lambda pulls and sends to the function.
   *
   * - SQS: default 10, max 10,000 (FIFO max 10)
   * - Kinesis: default 100, max 10,000
   * - DynamoDB Streams: default 100, max 10,000
   */
  batchSize?: number;
  /**
   * The maximum amount of time that Lambda spends gathering records before
   * invoking the function (e.g. `"5 seconds"`). Rounded to whole seconds on
   * the wire.
   * @default 0
   */
  maximumBatchingWindow?: Duration.Input;
  /**
   * Whether the event source mapping is active.
   * @default true
   */
  enabled?: boolean;
  /**
   * The position in a stream from which to start reading. Required for Kinesis and DynamoDB Streams.
   *
   * - `LATEST` - Read only new records.
   * - `TRIM_HORIZON` - Process all available records.
   * - `AT_TIMESTAMP` - Start reading from a specific time.
   */
  startingPosition?: StartingPosition;
  /**
   * The timestamp to start reading from when `startingPosition` is `AT_TIMESTAMP`.
   */
  startingPositionTimestamp?: Date;
  /**
   * (Kinesis and DynamoDB Streams) The number of batches to process from each shard concurrently.
   * @default 1
   */
  parallelizationFactor?: number;
  /**
   * (Kinesis and DynamoDB Streams) Split the batch in two and retry if the function returns an error.
   * @default false
   */
  bisectBatchOnFunctionError?: boolean;
  /**
   * (Kinesis and DynamoDB Streams) Discard records older than the specified
   * age (e.g. `"1 hour"`). Rounded to whole seconds on the wire.
   * @default infinite (omit to never expire records)
   */
  maximumRecordAge?: Duration.Input;
  /**
   * (Kinesis and DynamoDB Streams) Discard records after the specified number of retries.
   * @default -1 (infinite)
   */
  maximumRetryAttempts?: number;
  /**
   * (Kinesis and DynamoDB Streams) The duration of a processing window for
   * tumbling windows (e.g. `"30 seconds"`). Rounded to whole seconds on the
   * wire.
   */
  tumblingWindow?: Duration.Input;
  /**
   * A list of current response type enums applied to the event source mapping.
   * @default ["ReportBatchItemFailures"]
   */
  functionResponseTypes?: FunctionResponseType[];
  /**
   * (SQS) Scaling configuration for the event source.
   */
  scalingConfig?: lambda.ScalingConfig;
  /**
   * (Kinesis and DynamoDB Streams) A destination for records that failed processing.
   */
  destinationConfig?: lambda.DestinationConfig;
  /**
   * Filter criteria to control which records are sent to the function.
   */
  filterCriteria?: lambda.FilterCriteria;
  /**
   * The ARN of an AWS KMS key to encrypt the filter criteria.
   */
  kmsKeyArn?: string;
  /**
   * Metrics configuration for the event source mapping.
   * @default { Metrics: ["EventCount"] }
   */
  metricsConfig?: lambda.EventSourceMappingMetricsConfig;
  /**
   * (SQS, MSK, self-managed Kafka) Provisioned poller configuration.
   */
  provisionedPollerConfig?: lambda.ProvisionedPollerConfig;
  /**
   * (Amazon MSK) Configuration for an Amazon Managed Streaming for Apache Kafka event source.
   */
  amazonManagedKafkaEventSourceConfig?: lambda.AmazonManagedKafkaEventSourceConfig;
  /**
   * (Self-managed Kafka) Configuration for a self-managed Apache Kafka event source.
   */
  selfManagedKafkaEventSourceConfig?: lambda.SelfManagedKafkaEventSourceConfig;
  /**
   * (Self-managed Kafka) The self-managed Apache Kafka cluster for the event source.
   */
  selfManagedEventSource?: lambda.SelfManagedEventSource;
  /**
   * (Amazon MQ, MSK, self-managed Kafka) Source access configuration for VPC, authentication, etc.
   */
  sourceAccessConfigurations?: lambda.SourceAccessConfiguration[];
  /**
   * (Amazon MSK, self-managed Kafka) The Kafka topic name(s).
   */
  topics?: string[];
  /**
   * (Amazon MQ) The name of the Amazon MQ broker destination queue to consume.
   */
  queues?: string[];
  /**
   * (Amazon DocumentDB) Configuration for a DocumentDB event source.
   */
  documentDBEventSourceConfig?: lambda.DocumentDBEventSourceConfig;
  /**
   * (Amazon MSK and self-managed Apache Kafka) The logging configuration for the event source.
   */
  loggingConfig?: lambda.LoggingConfig;
  /**
   * Tags to associate with the event source mapping.
   */
  tags?: Record<string, string>;
}

export interface EventSourceMapping extends Resource<
  "AWS.Lambda.EventSourceMapping",
  EventSourceMappingProps,
  {
    /**
     * The UUID of the event source mapping.
     */
    uuid: string;
    /**
     * The ARN of the event source mapping.
     */
    eventSourceMappingArn: string;
    /**
     * The ARN of the Lambda function.
     */
    functionArn: string;
    /**
     * The current state of the event source mapping.
     */
    state: string;
  },
  never,
  Providers
> {}

/**
 * Connects an event source — an SQS queue, Kinesis stream, DynamoDB stream,
 * Amazon MQ broker, or Kafka topic — to a Lambda function so that records are
 * polled from the source and delivered to the function in batches.
 *
 * Most stacks create mappings indirectly through the higher-level event-source
 * helpers (`SQS.consumeQueueMessages(queue, ...)`,
 * `Kinesis.consumeStreamRecords(stream, ...)`, `DynamoDB.consumeTableChanges(table, ...)`),
 * which wire up the matching IAM permissions automatically. Use this resource
 * directly when you need full control over batching, starting position, retry
 * behavior, or filtering.
 *
 * @resource
 * @section Polling an SQS Queue
 * SQS is the simplest source: no `startingPosition` is needed because there is
 * no stream cursor. Lambda long-polls the queue and invokes the function with
 * up to `batchSize` messages, and `functionName` plus `eventSourceArn` are the
 * only required props.
 *
 * @example Subscribe a function to a queue
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const queue = yield* AWS.SQS.Queue("Jobs", {});
 * const worker = yield* AWS.Lambda.Function("Worker", {
 *   main: "./src/worker.ts",
 * });
 *
 * const mapping = yield* AWS.Lambda.EventSourceMapping("JobsToWorker", {
 *   functionName: worker.functionName,
 *   eventSourceArn: queue.queueArn,
 *   batchSize: 10,
 *   maximumBatchingWindow: "5 seconds",
 * });
 * ```
 *
 * This delivers up to 10 messages per invocation, waiting up to 5 seconds to
 * fill a batch before invoking. Increasing the batching window trades latency
 * for fewer, larger invocations — useful for amortizing cold starts or
 * downstream write costs on bursty queues.
 *
 * @section Streaming from Kinesis & DynamoDB
 * Stream sources (Kinesis and DynamoDB Streams) deliver records in shard order
 * and therefore require a `startingPosition` that tells Lambda where in the
 * shard to begin reading. These sources also unlock the stream-only tuning
 * knobs covered in the next sections.
 *
 * @example Process a Kinesis stream from the latest records
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const stream = yield* AWS.Kinesis.Stream("Events", {});
 * const consumer = yield* AWS.Lambda.Function("Consumer", {
 *   main: "./src/consumer.ts",
 * });
 *
 * const mapping = yield* AWS.Lambda.EventSourceMapping("EventsToConsumer", {
 *   functionName: consumer.functionName,
 *   eventSourceArn: stream.streamArn,
 *   startingPosition: "LATEST",
 *   batchSize: 100,
 * });
 * ```
 *
 * `startingPosition: "LATEST"` skips any backlog and only processes records
 * written after the mapping is created — the right choice for live event
 * pipelines where replaying history would be wasteful or incorrect.
 *
 * @example Replay a DynamoDB stream from the beginning
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const table = yield* AWS.DynamoDB.Table("Orders", {
 *   partitionKey: { name: "id", type: "S" },
 * });
 * const handler = yield* AWS.Lambda.Function("OrdersStream", {
 *   main: "./src/orders.ts",
 * });
 *
 * const mapping = yield* AWS.Lambda.EventSourceMapping("OrdersToHandler", {
 *   functionName: handler.functionName,
 *   eventSourceArn: table.latestStreamArn!,
 *   startingPosition: "TRIM_HORIZON",
 * });
 * ```
 *
 * `TRIM_HORIZON` starts at the oldest record still in the stream, so the
 * function processes the full available history before catching up to new
 * writes — use it when every change matters (e.g. building a projection).
 *
 * @example Start reading from a specific timestamp
 * ```typescript
 * const mapping = yield* AWS.Lambda.EventSourceMapping("EventsFromTime", {
 *   functionName: consumer.functionName,
 *   eventSourceArn: stream.streamArn,
 *   startingPosition: "AT_TIMESTAMP",
 *   startingPositionTimestamp: new Date("2026-01-01T00:00:00Z"),
 * });
 * ```
 *
 * `AT_TIMESTAMP` (Kinesis only) begins at the first record on or after
 * `startingPositionTimestamp`, letting you reprocess a known time range without
 * replaying the entire stream.
 *
 * @section Tuning Throughput
 * For stream sources, throughput is governed by how records are batched and how
 * many batches run in parallel per shard. These knobs let you balance
 * end-to-end latency against invocation count and downstream load.
 *
 * @example Increase parallelism and use tumbling windows
 * ```typescript
 * const mapping = yield* AWS.Lambda.EventSourceMapping("HighThroughput", {
 *   functionName: consumer.functionName,
 *   eventSourceArn: stream.streamArn,
 *   startingPosition: "LATEST",
 *   batchSize: 500,
 *   maximumBatchingWindow: "10 seconds",
 *   parallelizationFactor: 5,
 *   tumblingWindow: "30 seconds",
 * });
 * ```
 *
 * `parallelizationFactor` runs up to 5 concurrent batches per shard (records
 * with the same partition key still stay in order), while
 * `tumblingWindow` aggregates results across sequential batches for
 * windowed stream processing. Raising `batchSize`/`maximumBatchingWindow`
 * favors fewer, larger invocations.
 *
 * @section Error Handling & Retries
 * For stream sources a single poison-pill record can block a shard forever.
 * These props bound retries, split failing batches, expire stale records, and
 * route failures elsewhere instead of stalling the stream.
 *
 * @example Bisect on error, cap retries, and expire old records
 * ```typescript
 * const dlq = yield* AWS.SQS.Queue("StreamFailures", {});
 *
 * const mapping = yield* AWS.Lambda.EventSourceMapping("ResilientStream", {
 *   functionName: consumer.functionName,
 *   eventSourceArn: stream.streamArn,
 *   startingPosition: "LATEST",
 *   bisectBatchOnFunctionError: true,
 *   maximumRetryAttempts: 3,
 *   maximumRecordAge: "1 hour",
 *   destinationConfig: {
 *     OnFailure: { Destination: dlq.queueArn },
 *   },
 * });
 * ```
 *
 * On a function error, `bisectBatchOnFunctionError` splits the batch in two and
 * retries each half to isolate the bad record; after `maximumRetryAttempts` (or
 * once a record is older than `maximumRecordAge`) the record is
 * discarded and its metadata is sent to the `destinationConfig.OnFailure`
 * target so it is never silently lost.
 *
 * @example Report partial batch failures
 * ```typescript
 * const mapping = yield* AWS.Lambda.EventSourceMapping("PartialFailures", {
 *   functionName: handler.functionName,
 *   eventSourceArn: table.latestStreamArn!,
 *   startingPosition: "TRIM_HORIZON",
 *   functionResponseTypes: ["ReportBatchItemFailures"],
 * });
 * ```
 *
 * `functionResponseTypes: ["ReportBatchItemFailures"]` lets the function return
 * only the IDs of records it failed to process, so Lambda retries just those
 * instead of the whole batch — avoiding redundant reprocessing of records that
 * already succeeded.
 *
 * @section Filtering Records
 * Attach `filterCriteria` so the function is only invoked for records matching
 * an event pattern. Filtering happens before invocation, so it cuts both cost
 * and unnecessary cold starts. Encrypt the patterns with `kmsKeyArn` when they
 * contain sensitive values.
 *
 * @example Only deliver records where `type` is `"order"`
 * ```typescript
 * const mapping = yield* AWS.Lambda.EventSourceMapping("OrdersOnly", {
 *   functionName: worker.functionName,
 *   eventSourceArn: queue.queueArn,
 *   filterCriteria: {
 *     Filters: [{ Pattern: JSON.stringify({ body: { type: ["order"] } }) }],
 *   },
 *   kmsKeyArn:
 *     "arn:aws:kms:us-east-1:111122223333:key/abcd1234-...",
 * });
 * ```
 *
 * Each `Pattern` is a JSON event-pattern string; messages that don't match are
 * dropped without invoking the function. The optional `kmsKeyArn` encrypts the
 * stored filter criteria with your own KMS key instead of an AWS-managed one.
 *
 * @section Enabling & Disabling
 * The `enabled` flag controls whether Lambda actively polls the source without
 * deleting the mapping, so you can pause and resume delivery in place.
 *
 * @example Create a paused mapping
 * ```typescript
 * const mapping = yield* AWS.Lambda.EventSourceMapping("PausedConsumer", {
 *   functionName: consumer.functionName,
 *   eventSourceArn: stream.streamArn,
 *   startingPosition: "LATEST",
 *   enabled: false,
 * });
 * ```
 *
 * With `enabled: false` the mapping exists but pulls no records — flip it back
 * to `true` to resume. This is handy for maintenance windows or for staging a
 * consumer before turning on traffic.
 *
 * @section Scaling & Provisioned Pollers
 * Cap concurrency for SQS sources with `scalingConfig`, or reserve dedicated
 * polling capacity (for Kafka/MSK and SQS) with `provisionedPollerConfig` to
 * keep latency predictable under load.
 *
 * @example Limit SQS concurrency and provision pollers
 * ```typescript
 * const mapping = yield* AWS.Lambda.EventSourceMapping("BoundedConsumer", {
 *   functionName: worker.functionName,
 *   eventSourceArn: queue.queueArn,
 *   scalingConfig: { MaximumConcurrency: 10 },
 *   provisionedPollerConfig: {
 *     MinimumPollers: 1,
 *     MaximumPollers: 20,
 *   },
 * });
 * ```
 *
 * `scalingConfig.MaximumConcurrency` caps how many function instances Lambda
 * runs for this queue (protecting downstream systems), while
 * `provisionedPollerConfig` keeps a pool of dedicated event pollers warm so
 * throughput doesn't lag behind sudden spikes.
 *
 * @section Kafka, MQ & DocumentDB Sources
 * Beyond AWS-native streams, an event source mapping can poll Amazon MSK,
 * self-managed Apache Kafka, Amazon MQ brokers, and Amazon DocumentDB change
 * streams. These sources use `topics`/`queues` to select what to consume,
 * `sourceAccessConfigurations` for VPC and authentication wiring, and
 * source-specific config props.
 *
 * @example Consume a self-managed Kafka topic
 * ```typescript
 * const mapping = yield* AWS.Lambda.EventSourceMapping("KafkaConsumer", {
 *   functionName: consumer.functionName,
 *   eventSourceArn: stream.streamArn,
 *   topics: ["orders"],
 *   selfManagedEventSource: {
 *     Endpoints: { KAFKA_BOOTSTRAP_SERVERS: ["broker1:9092", "broker2:9092"] },
 *   },
 *   selfManagedKafkaEventSourceConfig: { ConsumerGroupId: "orders-consumer" },
 *   sourceAccessConfigurations: [
 *     { Type: "SASL_SCRAM_512_AUTH", URI: "arn:aws:secretsmanager:...:secret:kafka" },
 *   ],
 *   loggingConfig: { LogFormat: "JSON" },
 * });
 * ```
 *
 * `topics` names the Kafka topic(s) to read; `selfManagedEventSource.Endpoints`
 * points at the brokers; `sourceAccessConfigurations` supplies the SASL/VPC
 * credentials; and `selfManagedKafkaEventSourceConfig.ConsumerGroupId` pins the
 * consumer group. For Amazon MSK use `amazonManagedKafkaEventSourceConfig`
 * instead.
 *
 * @example Consume an Amazon MQ queue and a DocumentDB change stream
 * ```typescript
 * const mqMapping = yield* AWS.Lambda.EventSourceMapping("MqConsumer", {
 *   functionName: worker.functionName,
 *   eventSourceArn: stream.streamArn,
 *   queues: ["orders-queue"],
 *   sourceAccessConfigurations: [
 *     { Type: "BASIC_AUTH", URI: "arn:aws:secretsmanager:...:secret:mq" },
 *   ],
 * });
 *
 * const docDbMapping = yield* AWS.Lambda.EventSourceMapping("DocDbConsumer", {
 *   functionName: worker.functionName,
 *   eventSourceArn: stream.streamArn,
 *   documentDBEventSourceConfig: {
 *     DatabaseName: "shop",
 *     CollectionName: "orders",
 *     FullDocument: "UpdateLookup",
 *   },
 * });
 * ```
 *
 * For Amazon MQ, `queues` names the broker destination to consume and
 * `sourceAccessConfigurations` carries the broker credentials; for DocumentDB,
 * `documentDBEventSourceConfig` selects the database/collection and whether full
 * documents are delivered on updates.
 *
 * @section Metrics & Tags
 * Opt into per-mapping CloudWatch metrics with `metricsConfig` and brand the
 * mapping with your own `tags` (Alchemy also applies its internal ownership
 * tags automatically).
 *
 * @example Enable event metrics and add tags
 * ```typescript
 * const mapping = yield* AWS.Lambda.EventSourceMapping("ObservedConsumer", {
 *   functionName: worker.functionName,
 *   eventSourceArn: queue.queueArn,
 *   metricsConfig: { Metrics: ["EventCount"] },
 *   tags: { team: "payments", env: "prod" },
 * });
 * ```
 *
 * `metricsConfig.Metrics` turns on the named CloudWatch metrics (e.g.
 * `EventCount`) for this mapping, and `tags` attaches arbitrary key/value pairs
 * for cost allocation and discovery.
 */
export const EventSourceMapping = Resource<EventSourceMapping>(
  "AWS.Lambda.EventSourceMapping",
);

export const EventSourceMappingProvider = () =>
  Provider.effect(
    EventSourceMapping,
    Effect.gen(function* () {
      const createEventSourceMappingTags = Effect.fn(function* (id: string) {
        const internalTags = yield* createInternalTags(id);
        return {
          ...internalTags,
          "alchemy::id": sanitizeAwsTagValue(internalTags["alchemy::id"]),
        };
      });

      const toCreateRequest = (
        props: EventSourceMappingProps,
        tags: Record<string, string>,
      ): lambda.CreateEventSourceMappingRequest => ({
        FunctionName: props.functionName as string,
        EventSourceArn: props.eventSourceArn as string,
        Enabled: props.enabled ?? true,
        BatchSize: props.batchSize,
        MaximumBatchingWindowInSeconds: toWireSeconds(
          props.maximumBatchingWindow,
        ),
        StartingPosition: props.startingPosition,
        StartingPositionTimestamp: props.startingPositionTimestamp,
        ParallelizationFactor: props.parallelizationFactor,
        BisectBatchOnFunctionError: props.bisectBatchOnFunctionError,
        MaximumRecordAgeInSeconds: toWireSeconds(props.maximumRecordAge),
        MaximumRetryAttempts: props.maximumRetryAttempts,
        TumblingWindowInSeconds: toWireSeconds(props.tumblingWindow),
        FunctionResponseTypes: props.functionResponseTypes ?? [
          "ReportBatchItemFailures",
        ],
        ScalingConfig: props.scalingConfig,
        DestinationConfig: props.destinationConfig,
        FilterCriteria: props.filterCriteria,
        KMSKeyArn: props.kmsKeyArn,
        MetricsConfig: props.metricsConfig ?? { Metrics: ["EventCount"] },
        ProvisionedPollerConfig: props.provisionedPollerConfig,
        AmazonManagedKafkaEventSourceConfig:
          props.amazonManagedKafkaEventSourceConfig,
        SelfManagedKafkaEventSourceConfig:
          props.selfManagedKafkaEventSourceConfig,
        SelfManagedEventSource: props.selfManagedEventSource,
        SourceAccessConfigurations: props.sourceAccessConfigurations,
        Topics: props.topics,
        Queues: props.queues,
        DocumentDBEventSourceConfig: props.documentDBEventSourceConfig,
        LoggingConfig: props.loggingConfig,
        Tags: tags,
      });

      const toUpdateRequest = (
        uuid: string,
        props: EventSourceMappingProps,
      ): lambda.UpdateEventSourceMappingRequest => ({
        UUID: uuid,
        FunctionName: props.functionName as string,
        Enabled: props.enabled ?? true,
        BatchSize: props.batchSize,
        MaximumBatchingWindowInSeconds: toWireSeconds(
          props.maximumBatchingWindow,
        ),
        BisectBatchOnFunctionError: props.bisectBatchOnFunctionError,
        MaximumRecordAgeInSeconds: toWireSeconds(props.maximumRecordAge),
        MaximumRetryAttempts: props.maximumRetryAttempts,
        TumblingWindowInSeconds: toWireSeconds(props.tumblingWindow),
        FunctionResponseTypes: props.functionResponseTypes ?? [
          "ReportBatchItemFailures",
        ],
        ScalingConfig: props.scalingConfig,
        DestinationConfig: props.destinationConfig,
        FilterCriteria: props.filterCriteria,
        KMSKeyArn: props.kmsKeyArn,
        MetricsConfig: props.metricsConfig ?? { Metrics: ["EventCount"] },
        ProvisionedPollerConfig: props.provisionedPollerConfig,
        AmazonManagedKafkaEventSourceConfig:
          props.amazonManagedKafkaEventSourceConfig,
        SelfManagedKafkaEventSourceConfig:
          props.selfManagedKafkaEventSourceConfig,
        SourceAccessConfigurations: props.sourceAccessConfigurations,
        DocumentDBEventSourceConfig: props.documentDBEventSourceConfig,
        LoggingConfig: props.loggingConfig,
      });

      const configToAttrs = (
        config: lambda.EventSourceMappingConfiguration,
      ): EventSourceMapping["Attributes"] => ({
        uuid: config.UUID!,
        eventSourceMappingArn: config.EventSourceMappingArn!,
        functionArn: config.FunctionArn!,
        state: config.State!,
      });

      return {
        stables: ["uuid", "eventSourceMappingArn"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (
            (news.eventSourceArn as string) !== (olds.eventSourceArn as string)
          ) {
            return { action: "replace" } as const;
          }
          if (news.startingPosition !== olds.startingPosition) {
            return { action: "replace" } as const;
          }
          if (
            news.startingPositionTimestamp?.getTime() !==
            olds.startingPositionTimestamp?.getTime()
          ) {
            return { action: "replace" } as const;
          }
          if (
            !deepEqual(news.selfManagedEventSource, olds.selfManagedEventSource)
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const expectedInternalTags = yield* createEventSourceMappingTags(id);
          const desiredTags = { ...expectedInternalTags, ...news.tags };

          const functionName = news.functionName as string;
          const eventSourceArn = news.eventSourceArn as string;

          // Observe — find the existing mapping. UUIDs are server-assigned
          // so we either trust `output.uuid` (fast path) or scan
          // `listEventSourceMappings` and confirm ownership via tags
          // (recovery from a state-persistence failure or adoption).
          let config: lambda.EventSourceMappingConfiguration | undefined;
          if (output?.uuid) {
            config = yield* lambda
              .getEventSourceMapping({ UUID: output.uuid })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(undefined),
                ),
              );
          }
          if (!config?.UUID) {
            config = yield* lambda.listEventSourceMappings
              .pages({ FunctionName: functionName })
              .pipe(
                Stream.mapEffect(
                  Effect.fn(function* (page) {
                    const mapping = page.EventSourceMappings?.find(
                      (m) => m.EventSourceArn === eventSourceArn,
                    );
                    if (mapping?.UUID) {
                      const { Tags } = yield* lambda
                        .listTags({
                          Resource: `arn:aws:lambda:${region}:${accountId}:event-source-mapping:${mapping.UUID}`,
                        })
                        .pipe(retryTransient);
                      if (hasTags(expectedInternalTags, Tags)) {
                        return mapping;
                      }
                    }
                  }),
                ),
                Stream.filter((item) => item !== undefined),
                Stream.runHead,
                Effect.map(Option.getOrUndefined),
              );
          }

          // Ensure — create if no live mapping exists. Tolerate
          // `ResourceConflictException` (peer reconciler raced ahead) by
          // re-scanning to find the mapping by tag ownership.
          if (!config?.UUID) {
            config = yield* lambda
              .createEventSourceMapping(toCreateRequest(news, desiredTags))
              .pipe(
                Effect.catchTags({
                  ResourceConflictException: () =>
                    lambda.listEventSourceMappings
                      .pages({ FunctionName: functionName })
                      .pipe(
                        Stream.mapEffect(
                          Effect.fn(function* (page) {
                            const mapping = page.EventSourceMappings?.find(
                              (m) => m.EventSourceArn === eventSourceArn,
                            );
                            if (mapping?.UUID) {
                              const { Tags } = yield* lambda
                                .listTags({
                                  Resource: `arn:aws:lambda:${region}:${accountId}:event-source-mapping:${mapping.UUID}`,
                                })
                                .pipe(retryTransient);
                              if (hasTags(expectedInternalTags, Tags)) {
                                return mapping;
                              }
                            }
                          }),
                        ),
                        Stream.filter((item) => item !== undefined),
                        Stream.runHead,
                        Effect.map(Option.getOrUndefined),
                        Effect.flatMap((mapping) =>
                          mapping
                            ? Effect.succeed(mapping)
                            : Effect.die(
                                new Error(
                                  `EventSourceMapping(${id}) not found on function ${functionName}`,
                                ),
                              ),
                        ),
                      ),
                }),
                retryPermissionsPropagation,
                retryTransient,
              );
          }

          if (!config?.UUID) {
            return yield* Effect.die(
              new Error(`EventSourceMapping(${id}) could not be reconciled`),
            );
          }

          const uuid = config.UUID;
          const mappingArn = `arn:aws:lambda:${region}:${accountId}:event-source-mapping:${uuid}`;

          // Sync configuration — `updateEventSourceMapping` is a full PUT
          // for mutable fields. We always send the full desired config so
          // observed state converges. Retry `ResourceInUseException`
          // (mapping is transitioning) and known IAM-propagation errors.
          config = yield* lambda
            .updateEventSourceMapping(toUpdateRequest(uuid, news))
            .pipe(
              Effect.retry({
                while: (e: any) =>
                  e._tag === "ResourceInUseException" ||
                  e._tag === "ResourceConflictException",
                schedule: Schedule.max([
                  Schedule.exponential(100),
                  Schedule.recurs(20),
                ]),
              }),
              retryPermissionsPropagation,
              retryTransient,
            );

          // Sync tags — diff observed cloud tags against desired so
          // adoption rewrites ownership tags correctly.
          const observedTagsResp = yield* lambda
            .listTags({ Resource: mappingArn })
            .pipe(retryTransient);
          const observedTags: Record<string, string> = Object.fromEntries(
            Object.entries(observedTagsResp.Tags ?? {}).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          );
          const { removed, upsert } = diffTags(observedTags, desiredTags);

          if (removed.length > 0) {
            yield* lambda
              .untagResource({ Resource: mappingArn, TagKeys: removed })
              .pipe(retryTransient);
          }
          if (upsert.length > 0) {
            const tagsToAdd: Record<string, string> = {};
            for (const { Key, Value } of upsert) {
              tagsToAdd[Key] = Value;
            }
            yield* lambda
              .tagResource({ Resource: mappingArn, Tags: tagsToAdd })
              .pipe(retryTransient);
          }

          yield* session.note(config.EventSourceMappingArn ?? uuid);

          return configToAttrs(config);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* lambda.deleteEventSourceMapping({ UUID: output.uuid }).pipe(
            Effect.retry({
              while: (e: any) =>
                e._tag === "ResourceInUseException" ||
                e._tag === "ResourceConflictException",
              schedule: Schedule.max([
                Schedule.exponential(100),
                Schedule.recurs(20),
              ]),
            }),
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
        // `list()` — AWS account/region collection (§4a). Exhaustively
        // paginate `listEventSourceMappings` with no `FunctionName` filter to
        // enumerate every mapping in the current region, hydrating each into
        // the exact `Attributes` shape `reconcile`/`configToAttrs` returns.
        // The list response carries full `EventSourceMappingConfiguration`
        // objects, so there is no per-item `getEventSourceMapping` to issue —
        // hence no bounded fan-out or per-item `ResourceNotFoundException`
        // handling is required. We drop any partial entry missing a required
        // identifier field rather than emitting a malformed `Attributes`.
        list: () =>
          lambda.listEventSourceMappings.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.EventSourceMappings ?? [])
                  .filter(
                    (
                      config,
                    ): config is lambda.EventSourceMappingConfiguration & {
                      UUID: string;
                      EventSourceMappingArn: string;
                      FunctionArn: string;
                      State: string;
                    } =>
                      config.UUID != null &&
                      config.EventSourceMappingArn != null &&
                      config.FunctionArn != null &&
                      config.State != null,
                  )
                  .map(configToAttrs),
              ),
            ),
          ),
      };
    }),
  );

const retryTransient: <A, R, Err>(
  self: Effect.Effect<A, Err, R>,
) => Effect.Effect<A, Err, R> = Effect.retry({
  while: (e: any) =>
    e._tag === "InternalFailure" ||
    e._tag === "RequestExpired" ||
    e._tag === "ServiceException" ||
    e._tag === "ServiceUnavailable" ||
    e._tag === "ThrottlingException" ||
    e._tag === "TooManyRequestsException" ||
    e._tag === "RequestLimitExceeded" ||
    e._tag === "ResourceInUseException",
  schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(30)]),
});

const retryPermissionsPropagation = Effect.retry({
  while: (e: any) =>
    e._tag === "InvalidParameterValueException" &&
    (e.message?.includes(
      "The function execution role does not have permissions to call",
    ) ||
      e.message?.includes("cannot be assumed by Lambda") ||
      e.message?.includes("Please add Lambda as a Trusted Entity") ||
      e.message?.includes("Cannot access stream") ||
      e.message?.includes("Please ensure the role can perform the GetRecords")),
  schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(30)]),
}) as <A, R, Err>(self: Effect.Effect<A, Err, R>) => Effect.Effect<A, Err, R>;

const sanitizeAwsTagValue = (value: string) =>
  value.replace(/[^\p{L}\p{Z}\p{N}_.:/=+\-@]/gu, "-");
