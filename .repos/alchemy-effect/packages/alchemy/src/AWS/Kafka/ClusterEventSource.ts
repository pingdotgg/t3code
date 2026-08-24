import type * as Lambda from "@distilled.cloud/aws/lambda";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import type { ServerlessCluster } from "./ServerlessCluster.ts";

export type MSKRecord = import("aws-lambda").MSKRecord;

export interface KafkaEventSourceProps {
  /**
   * The Kafka topic name(s) the function consumes. At least one is required.
   */
  topics: string[];
  /**
   * The Kafka consumer group id used by the event source poller.
   * @default a Lambda-generated id
   */
  consumerGroupId?: string;
  /**
   * The position in the topic from which the poller starts reading.
   * @default "LATEST"
   */
  startingPosition?: "TRIM_HORIZON" | "LATEST";
  /**
   * The maximum number of records in each batch that Lambda pulls from the topic.
   * @default 100
   */
  batchSize?: number;
  /**
   * The maximum time Lambda spends gathering records before invoking the
   * function, e.g. `"5 seconds"` or `Duration.seconds(5)`. Rounded to whole
   * seconds on the wire.
   * @default 500ms (0)
   */
  maximumBatchingWindow?: Duration.Input;
  /**
   * Whether the event source mapping actively polls.
   * @default true
   */
  enabled?: boolean;
  /**
   * Filter criteria to control which records are sent to the function.
   */
  filterCriteria?: Lambda.FilterCriteria;
  /**
   * Provisioned poller configuration for predictable throughput.
   */
  provisionedPollerConfig?: Lambda.ProvisionedPollerConfig;
}

/**
 * Event source connecting topics on an MSK `ServerlessCluster` to the
 * hosting compute.
 *
 * The contract is a `Binding.Service`; the Lambda implementation layer
 * (`AWS.Lambda.KafkaEventSource`) grants the IAM actions MSK IAM
 * authentication requires, creates an event source mapping on the cluster,
 * and forwards `aws:kafka` records into the handler's `Stream`. Use the
 * {@link consumeKafkaTopic} helper rather than calling the service directly.
 * @binding
 * @section Consuming Topics
 * @example Consume a Topic in a Lambda Function
 * ```typescript
 * export default MyFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const cluster = yield* AWS.Kafka.ServerlessCluster("Events", {
 *       subnetIds,
 *     });
 *
 *     // init — registers the event source mapping and the record handler
 *     yield* AWS.Kafka.consumeKafkaTopic(
 *       cluster,
 *       { topics: ["orders"], consumerGroupId: "my-service" },
 *       (records) =>
 *         records.pipe(Stream.runForEach((r) => Effect.log(r.value))),
 *     );
 *
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.KafkaEventSource)),
 * );
 * ```
 */
export interface KafkaEventSource extends Binding.Service<
  KafkaEventSource,
  "AWS.Kafka.KafkaEventSource",
  KafkaEventSourceService
> {}

export const KafkaEventSource = Binding.Service<KafkaEventSource>(
  "AWS.Kafka.KafkaEventSource",
);

export type KafkaEventSourceService = <StreamReq = never, Req = never>(
  cluster: ServerlessCluster,
  props: KafkaEventSourceProps,
  process: (
    stream: Stream.Stream<MSKRecord, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;

/**
 * Subscribe a runtime to records from one or more topics on an MSK
 * {@link ServerlessCluster}.
 *
 * The Lambda runtime implementation grants the IAM actions MSK IAM
 * authentication requires, creates an event source mapping pointing at the
 * cluster, and forwards matching `aws:kafka` records into the supplied
 * `Stream`.
 *
 * @example Consume the "orders" topic
 * ```typescript
 * yield* AWS.Kafka.consumeKafkaTopic(
 *   cluster,
 *   { topics: ["orders"], startingPosition: "TRIM_HORIZON" },
 *   (records) =>
 *     records.pipe(
 *       Stream.runForEach((record) =>
 *         Effect.log(Buffer.from(record.value, "base64").toString("utf8")),
 *       ),
 *     ),
 * );
 * ```
 */
export const consumeKafkaTopic = <
  C extends ServerlessCluster,
  Req = never,
  StreamReq = never,
>(
  cluster: C,
  props: KafkaEventSourceProps,
  process: (
    stream: Stream.Stream<MSKRecord, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) => KafkaEventSource.use((source) => source(cluster, props, process));
