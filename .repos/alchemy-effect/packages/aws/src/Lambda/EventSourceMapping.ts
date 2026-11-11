import * as lambda from "@distilled.cloud/aws/lambda";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { createInternalTags, diffTags, hasTags, tagRecord } from "alchemy/Tags";
import { toWireSeconds } from "alchemy/Util/Duration";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { AWSEnvironment } from "../Environment.ts";
import { plainJson } from "../internal/Observe.ts";
import type { Providers } from "../Providers.ts";

export type StartingPosition = "TRIM_HORIZON" | "LATEST" | "AT_TIMESTAMP";

/** Internal retry signal: the mapping has not reached its desired state yet. */
class MappingNotSettled extends Data.TaggedError("MappingNotSettled")<{
  readonly state: string | undefined;
}> {}

/**
 * An SQS queue's visibility timeout is shorter than the function's Lambda
 * timeout, which AWS refuses for an SQS event source. Lambda's timeout is the
 * function's `timeout` plus its `timeoutMargin` (1 second by default).
 */
export class QueueVisibilityTimeoutBelowFunctionTimeout extends Data.TaggedError(
  "QueueVisibilityTimeoutBelowFunctionTimeout",
)<{
  readonly functionName: string;
  readonly eventSourceArn: string;
  readonly message: string;
}> {}

/** AWS's rejection, restated with the setting to change. */
const visibilityTimeoutError = (
  functionName: string,
  eventSourceArn: string,
  error: lambda.QueueVisibilityTimeoutTooShort,
) =>
  new QueueVisibilityTimeoutBelowFunctionTimeout({
    functionName,
    eventSourceArn,
    message:
      `${error.message ?? "Queue visibility timeout is less than Function timeout"}. ` +
      "Lambda runs the function for its `timeout` plus `timeoutMargin` (1 second by " +
      "default), so set the queue's `visibilityTimeout` to at least that sum (AWS " +
      "recommends six times the function timeout), or lower the function's `timeout`.",
  });

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
   * Defaults to `["ReportBatchItemFailures"]` for SQS, Kinesis and DynamoDB
   * Streams sources, and for other sources (e.g. Kafka/MSK) only when
   * `provisionedPollerConfig.MinimumPollers` is set — they reject it otherwise.
   * @default ["ReportBatchItemFailures"] (SQS, Kinesis, DynamoDB Streams)
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
   * Metrics configuration for the event source mapping. Defaulted only for
   * SQS, Kinesis and DynamoDB Streams sources, or other sources (Kafka/MSK)
   * with `provisionedPollerConfig.MinimumPollers` set.
   * @default { Metrics: ["EventCount"] } (where supported)
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
    /**
     * Enabled state, batching, retry, failure-destination, filter, scaling
     * and metrics settings (those the props declare, plus the ones Alchemy
     * defaults), and the tags, as observed. Lets `alchemy drift` detect a
     * consumer disabled or reconfigured out of band.
     */
    configuration?: Record<string, unknown>;
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
 * ### Polling an SQS Queue
 * SQS is the simplest source: no `startingPosition` is needed because there is
 * no stream cursor. Lambda long-polls the queue and invokes the function with
 * up to `batchSize` messages, and `functionName` plus `eventSourceArn` are the
 * only required props.
 *
 * **Example:** Subscribe a function to a queue
 * ```typescript
 * import * as AWS from "@alchemy.run/aws";
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
 * ### Streaming from Kinesis & DynamoDB
 * Stream sources (Kinesis and DynamoDB Streams) deliver records in shard order
 * and therefore require a `startingPosition` that tells Lambda where in the
 * shard to begin reading. These sources also unlock the stream-only tuning
 * knobs covered in the next sections.
 *
 * **Example:** Process a Kinesis stream from the latest records
 * ```typescript
 * import * as AWS from "@alchemy.run/aws";
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
 * **Example:** Replay a DynamoDB stream from the beginning
 * ```typescript
 * import * as AWS from "@alchemy.run/aws";
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
 * **Example:** Start reading from a specific timestamp
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
 * ### Tuning Throughput
 * For stream sources, throughput is governed by how records are batched and how
 * many batches run in parallel per shard. These knobs let you balance
 * end-to-end latency against invocation count and downstream load.
 *
 * **Example:** Increase parallelism and use tumbling windows
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
 * ### Error Handling & Retries
 * For stream sources a single poison-pill record can block a shard forever.
 * These props bound retries, split failing batches, expire stale records, and
 * route failures elsewhere instead of stalling the stream.
 *
 * **Example:** Bisect on error, cap retries, and expire old records
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
 * **Example:** Report partial batch failures
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
 * ### Filtering Records
 * Attach `filterCriteria` so the function is only invoked for records matching
 * an event pattern. Filtering happens before invocation, so it cuts both cost
 * and unnecessary cold starts. Encrypt the patterns with `kmsKeyArn` when they
 * contain sensitive values.
 *
 * **Example:** Only deliver records where `type` is `"order"`
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
 * ### Enabling & Disabling
 * The `enabled` flag controls whether Lambda actively polls the source without
 * deleting the mapping, so you can pause and resume delivery in place.
 *
 * **Example:** Create a paused mapping
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
 * ### Scaling & Provisioned Pollers
 * Cap concurrency for SQS sources with `scalingConfig`, or reserve dedicated
 * polling capacity (for Kafka/MSK and SQS) with `provisionedPollerConfig` to
 * keep latency predictable under load.
 *
 * **Example:** Limit SQS concurrency and provision pollers
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
 * ### Kafka, MQ & DocumentDB Sources
 * Beyond AWS-native streams, an event source mapping can poll Amazon MSK,
 * self-managed Apache Kafka, Amazon MQ brokers, and Amazon DocumentDB change
 * streams. These sources use `topics`/`queues` to select what to consume,
 * `sourceAccessConfigurations` for VPC and authentication wiring, and
 * source-specific config props.
 *
 * **Example:** Consume a self-managed Kafka topic
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
 * **Example:** Consume an Amazon MQ queue and a DocumentDB change stream
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
 * ### Metrics & Tags
 * Opt into per-mapping CloudWatch metrics with `metricsConfig` and brand the
 * mapping with your own `tags` (Alchemy also applies its internal ownership
 * tags automatically).
 *
 * **Example:** Enable event metrics and add tags
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
 *
 * @resource
 */
export const EventSourceMapping = Resource<EventSourceMapping>("AWS.Lambda.EventSourceMapping");

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

      // ReportBatchItemFailures and MetricsConfig are only accepted for
      // SQS / Kinesis / DynamoDB Streams, or for other sources (Kafka/MSK)
      // in provisioned-poller mode — MSK rejects them otherwise ("... is only
      // available for provisioned mode"). Only default them where valid.
      const supportsDefaults = (props: EventSourceMappingProps): boolean =>
        /^arn:[^:]+:(sqs|kinesis|dynamodb):/.test(String(props.eventSourceArn)) ||
        props.provisionedPollerConfig?.MinimumPollers !== undefined;
      const defaultFunctionResponseTypes = (
        props: EventSourceMappingProps,
      ): FunctionResponseType[] | undefined =>
        props.functionResponseTypes ??
        (supportsDefaults(props) ? ["ReportBatchItemFailures"] : undefined);
      const defaultMetricsConfig = (
        props: EventSourceMappingProps,
      ): lambda.EventSourceMappingMetricsConfig | undefined =>
        props.metricsConfig ?? (supportsDefaults(props) ? { Metrics: ["EventCount"] } : undefined);

      const toCreateRequest = (
        props: EventSourceMappingProps,
        tags: Record<string, string>,
      ): lambda.CreateEventSourceMappingRequest => ({
        FunctionName: props.functionName as string,
        EventSourceArn: props.eventSourceArn as string,
        Enabled: props.enabled ?? true,
        BatchSize: props.batchSize,
        MaximumBatchingWindowInSeconds: toWireSeconds(props.maximumBatchingWindow),
        StartingPosition: props.startingPosition,
        StartingPositionTimestamp: props.startingPositionTimestamp,
        ParallelizationFactor: props.parallelizationFactor,
        BisectBatchOnFunctionError: props.bisectBatchOnFunctionError,
        MaximumRecordAgeInSeconds: toWireSeconds(props.maximumRecordAge),
        MaximumRetryAttempts: props.maximumRetryAttempts,
        TumblingWindowInSeconds: toWireSeconds(props.tumblingWindow),
        FunctionResponseTypes: defaultFunctionResponseTypes(props),
        ScalingConfig: props.scalingConfig,
        DestinationConfig: props.destinationConfig,
        FilterCriteria: props.filterCriteria,
        KMSKeyArn: props.kmsKeyArn,
        MetricsConfig: defaultMetricsConfig(props),
        ProvisionedPollerConfig: props.provisionedPollerConfig,
        AmazonManagedKafkaEventSourceConfig: props.amazonManagedKafkaEventSourceConfig,
        SelfManagedKafkaEventSourceConfig: props.selfManagedKafkaEventSourceConfig,
        SelfManagedEventSource: props.selfManagedEventSource,
        SourceAccessConfigurations: props.sourceAccessConfigurations,
        Topics: props.topics,
        Queues: props.queues,
        DocumentDBEventSourceConfig: props.documentDBEventSourceConfig,
        LoggingConfig: props.loggingConfig,
        Tags: tags,
      });

      const withoutConsumerGroupId = <
        C extends { ConsumerGroupId?: string; SchemaRegistryConfig?: unknown },
      >(
        config: C | undefined,
      ): C | undefined =>
        config?.SchemaRegistryConfig === undefined
          ? undefined
          : ({ ...config, ConsumerGroupId: undefined } as C);

      const toUpdateRequest = (
        uuid: string,
        props: EventSourceMappingProps,
      ): lambda.UpdateEventSourceMappingRequest => ({
        UUID: uuid,
        FunctionName: props.functionName as string,
        Enabled: props.enabled ?? true,
        BatchSize: props.batchSize,
        MaximumBatchingWindowInSeconds: toWireSeconds(props.maximumBatchingWindow),
        BisectBatchOnFunctionError: props.bisectBatchOnFunctionError,
        MaximumRecordAgeInSeconds: toWireSeconds(props.maximumRecordAge),
        MaximumRetryAttempts: props.maximumRetryAttempts,
        TumblingWindowInSeconds: toWireSeconds(props.tumblingWindow),
        FunctionResponseTypes: defaultFunctionResponseTypes(props),
        ScalingConfig: props.scalingConfig,
        DestinationConfig: props.destinationConfig,
        FilterCriteria: props.filterCriteria,
        KMSKeyArn: props.kmsKeyArn,
        MetricsConfig: defaultMetricsConfig(props),
        ProvisionedPollerConfig: props.provisionedPollerConfig,
        // ConsumerGroupId is create-only — UpdateEventSourceMapping rejects it
        // ("Unsupported '...consumerGroupId' parameter"); changing it replaces.
        AmazonManagedKafkaEventSourceConfig: withoutConsumerGroupId(
          props.amazonManagedKafkaEventSourceConfig,
        ),
        SelfManagedKafkaEventSourceConfig: withoutConsumerGroupId(
          props.selfManagedKafkaEventSourceConfig,
        ),
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

      /**
       * The settings reconcile converges, as observed. Update leaves an
       * omitted field unchanged, so a field is observed only when the props
       * declare it (or Alchemy defaults it). `read` and `reconcile` share it
       * so a converged mapping reads unchanged.
       */
      const observeMappingConfiguration = (
        config: lambda.EventSourceMappingConfiguration,
        props: EventSourceMappingProps | undefined,
        tags: Record<string, string>,
      ) => {
        const declared = <V>(key: keyof EventSourceMappingProps, value: V) =>
          props?.[key] === undefined ? undefined : value;
        return plainJson({
          // Transitional states (Creating, Updating) count as enabled.
          enabled: config.State !== "Disabled" && config.State !== "Disabling",
          batchSize: declared("batchSize", config.BatchSize),
          maximumBatchingWindowInSeconds: declared(
            "maximumBatchingWindow",
            config.MaximumBatchingWindowInSeconds,
          ),
          bisectBatchOnFunctionError: declared(
            "bisectBatchOnFunctionError",
            config.BisectBatchOnFunctionError,
          ),
          maximumRecordAgeInSeconds: declared("maximumRecordAge", config.MaximumRecordAgeInSeconds),
          maximumRetryAttempts: declared("maximumRetryAttempts", config.MaximumRetryAttempts),
          tumblingWindowInSeconds: declared("tumblingWindow", config.TumblingWindowInSeconds),
          functionResponseTypes:
            props === undefined || defaultFunctionResponseTypes(props) === undefined
              ? undefined
              : [...(config.FunctionResponseTypes ?? [])].sort(),
          scalingConfig: declared("scalingConfig", config.ScalingConfig),
          destinationConfig: declared("destinationConfig", config.DestinationConfig),
          filterCriteria: declared("filterCriteria", config.FilterCriteria),
          kmsKeyArn: declared("kmsKeyArn", config.KMSKeyArn),
          metricsConfig:
            props === undefined || defaultMetricsConfig(props) === undefined
              ? undefined
              : config.MetricsConfig,
          provisionedPollerConfig: declared(
            "provisionedPollerConfig",
            config.ProvisionedPollerConfig,
          ),
          loggingConfig: declared("loggingConfig", config.LoggingConfig),
          tags,
        });
      };

      const readMappingTags = (mappingArn: string) =>
        lambda.listTags({ Resource: mappingArn }).pipe(
          retryTransient,
          Effect.map((r) => tagRecord(r.Tags)),
        );

      const deleteMapping = (uuid: string) =>
        lambda.deleteEventSourceMapping({ UUID: uuid }).pipe(
          Effect.retry({
            while: (e) =>
              e._tag === "ResourceInUseException" || e._tag === "ResourceConflictException",
            schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(20)]),
          }),
          Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        );

      return {
        stables: ["uuid", "eventSourceMappingArn"],
        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          let config: lambda.EventSourceMappingConfiguration | undefined;
          if (output?.uuid) {
            config = yield* lambda
              .getEventSourceMapping({ UUID: output.uuid })
              .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));
          } else if (olds?.functionName && olds.eventSourceArn) {
            // No persisted UUID (interrupted create): find this stack's
            // mapping for the function and source by its ownership tags.
            const expectedInternalTags = yield* createEventSourceMappingTags(id);
            config = yield* lambda.listEventSourceMappings
              .pages({ FunctionName: olds.functionName })
              .pipe(
                Stream.flatMap((page) => Stream.fromIterable(page.EventSourceMappings ?? [])),
                Stream.filter((m) => m.EventSourceArn === olds.eventSourceArn && !!m.UUID),
                Stream.filterEffect((m) =>
                  readMappingTags(
                    `arn:aws:lambda:${region}:${accountId}:event-source-mapping:${m.UUID}`,
                  ).pipe(Effect.map((tags) => hasTags(expectedInternalTags, tags))),
                ),
                Stream.runHead,
                Effect.map(Option.getOrUndefined),
                Effect.catchTag("ResourceNotFoundException", () => Effect.undefined),
              );
          }
          if (!config?.UUID || config.State === "Deleting") return undefined;
          const tags = yield* readMappingTags(
            `arn:aws:lambda:${region}:${accountId}:event-source-mapping:${config.UUID}`,
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed({} as Record<string, string>),
            ),
          );
          return {
            ...configToAttrs(config),
            configuration: observeMappingConfiguration(config, olds, tags),
          };
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          // `functionName` is required, so this narrows `news` to the props object.
          if (!("functionName" in news)) return;
          const sourceArn = news.eventSourceArn;
          if (isResolved(sourceArn) && sourceArn !== olds.eventSourceArn) {
            return { action: "replace" } as const;
          }
          // Lambda allows one mapping per function and source, so a replacement
          // on the same source must delete the old mapping first.
          const replace = { action: "replace", deleteFirst: true } as const;
          if (
            isResolved(news.startingPosition) &&
            news.startingPosition !== olds.startingPosition
          ) {
            return replace;
          }
          if (
            isResolved(news.startingPositionTimestamp) &&
            news.startingPositionTimestamp?.getTime() !== olds.startingPositionTimestamp?.getTime()
          ) {
            return replace;
          }
          if (
            isResolved(news.selfManagedEventSource) &&
            !deepEqual(news.selfManagedEventSource, olds.selfManagedEventSource)
          ) {
            return replace;
          }
          if (
            (isResolved(news.amazonManagedKafkaEventSourceConfig) &&
              news.amazonManagedKafkaEventSourceConfig?.ConsumerGroupId !==
                olds.amazonManagedKafkaEventSourceConfig?.ConsumerGroupId) ||
            (isResolved(news.selfManagedKafkaEventSourceConfig) &&
              news.selfManagedKafkaEventSourceConfig?.ConsumerGroupId !==
                olds.selfManagedKafkaEventSourceConfig?.ConsumerGroupId)
          ) {
            return replace;
          }
          // An unresolved source ARN may or may not change: a replaced queue
          // gets a new ARN, but a Table updated in place keeps its stream ARN
          // while exposing it as unstable. Update in place and let `reconcile`
          // move the mapping if the source really changed, so the mapping's
          // identity is not stable for downstream consumers.
          if (!isResolved(sourceArn)) {
            return { action: "update", stables: [] } as const;
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
              .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));
          }
          // `updateEventSourceMapping` cannot change the source, so a mapping
          // that reads another source (its source was replaced) is recreated
          // for this source and the stale one deleted.
          let stale: string | undefined;
          if (config?.UUID && config.EventSourceArn !== eventSourceArn) {
            stale = config.UUID;
            config = undefined;
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
                    lambda.listEventSourceMappings.pages({ FunctionName: functionName }).pipe(
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
                Effect.catchTag("QueueVisibilityTimeoutTooShort", (error) =>
                  Effect.fail(visibilityTimeoutError(functionName, eventSourceArn, error)),
                ),
              );
          }

          if (!config?.UUID) {
            return yield* Effect.die(
              new Error(`EventSourceMapping(${id}) could not be reconciled`),
            );
          }

          const uuid = config.UUID;
          if (stale !== undefined && stale !== uuid) {
            yield* deleteMapping(stale);
          }
          const mappingArn = `arn:aws:lambda:${region}:${accountId}:event-source-mapping:${uuid}`;

          // Sync configuration — `updateEventSourceMapping` is a full PUT
          // for mutable fields. We always send the full desired config so
          // observed state converges. Retry `ResourceInUseException`
          // (mapping is transitioning) and known IAM-propagation errors.
          config = yield* lambda.updateEventSourceMapping(toUpdateRequest(uuid, news)).pipe(
            Effect.retry({
              while: (e: any) =>
                e._tag === "ResourceInUseException" || e._tag === "ResourceConflictException",
              schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(20)]),
            }),
            retryPermissionsPropagation,
            retryTransient,
            Effect.catchTag("QueueVisibilityTimeoutTooShort", (error) =>
              Effect.fail(visibilityTimeoutError(functionName, eventSourceArn, error)),
            ),
          );

          // Wait for the mapping to settle into its desired terminal state.
          // A fresh mapping sits in `Creating` for up to ~a minute before
          // Lambda actually starts polling — and for stream sources with
          // `startingPosition: LATEST`, records written before polling
          // starts are silently skipped. Returning early would hand the
          // caller a mapping that looks deployed but drops events.
          const desiredState = (news.enabled ?? true) ? "Enabled" : "Disabled";
          if (config.State !== desiredState) {
            config = yield* lambda.getEventSourceMapping({ UUID: uuid }).pipe(
              Effect.flatMap((observed) =>
                observed.State === desiredState
                  ? Effect.succeed(observed)
                  : Effect.fail(new MappingNotSettled({ state: observed.State })),
              ),
              Effect.retry({
                while: (e) => e._tag === "MappingNotSettled",
                schedule: Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(45)]).pipe(
                  Schedule.tap(({ attempt }) =>
                    session.note(
                      `EventSourceMapping ${uuid}: waiting to become ${desiredState} (${(attempt + 1) * 2}s elapsed)`,
                    ),
                  ),
                ),
              }),
              // Never wedge a deploy on a mapping stuck in transition —
              // surface the observed state in the attributes instead.
              Effect.catchTag("MappingNotSettled", () =>
                lambda.getEventSourceMapping({ UUID: uuid }),
              ),
            );
          }

          // Sync tags — diff observed cloud tags against desired so
          // adoption rewrites ownership tags correctly.
          const observedTagsResp = yield* lambda
            .listTags({ Resource: mappingArn })
            .pipe(retryTransient);
          const observedTags: Record<string, string> = Object.fromEntries(
            Object.entries(observedTagsResp.Tags ?? {}).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
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

          return {
            ...configToAttrs(config),
            configuration: observeMappingConfiguration(config, news, desiredTags),
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteMapping(output.uuid);
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

const retryTransient: <A, R, Err>(self: Effect.Effect<A, Err, R>) => Effect.Effect<A, Err, R> =
  Effect.retry({
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
  while: (e: { _tag: string }) =>
    e._tag === "ExecutionRoleNotAssumable" || e._tag === "ExecutionRoleMissingPermissions",
  schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(30)]),
}) as <A, R, Err extends { _tag: string }>(
  self: Effect.Effect<A, Err, R>,
) => Effect.Effect<A, Err, R>;

const sanitizeAwsTagValue = (value: string) => value.replace(/[^\p{L}\p{Z}\p{N}_.:/=+\-@]/gu, "-");
