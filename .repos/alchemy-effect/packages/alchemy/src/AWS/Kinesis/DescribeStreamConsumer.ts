import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { StreamConsumer } from "./StreamConsumer.ts";

export interface DescribeStreamConsumerRequest extends Omit<
  Kinesis.DescribeStreamConsumerInput,
  "ConsumerARN" | "StreamARN" | "ConsumerName"
> {}

/**
 * Runtime binding for `kinesis:DescribeStreamConsumer`.
 *
 * Bind this operation to a `StreamConsumer` to read the enhanced fan-out
 * consumer's status and ARN — the consumer ARN is injected automatically.
 * Provide the implementation with
 * `Effect.provide(AWS.Kinesis.DescribeStreamConsumerHttp)`.
 * @binding
 * @section Enhanced Fan-Out
 * @example Describe a Registered Consumer
 * ```typescript
 * const consumer = yield* AWS.Kinesis.StreamConsumer("Analytics", {
 *   streamArn: stream.streamArn,
 * });
 * // init
 * const describeStreamConsumer =
 *   yield* AWS.Kinesis.DescribeStreamConsumer(consumer);
 *
 * // runtime
 * const result = yield* describeStreamConsumer();
 * const status = result.ConsumerDescription.ConsumerStatus;
 * ```
 */
export interface DescribeStreamConsumer extends Binding.Service<
  DescribeStreamConsumer,
  "AWS.Kinesis.DescribeStreamConsumer",
  (
    consumer: StreamConsumer,
  ) => Effect.Effect<
    (
      request?: DescribeStreamConsumerRequest,
    ) => Effect.Effect<
      Kinesis.DescribeStreamConsumerOutput,
      Kinesis.DescribeStreamConsumerError
    >
  >
> {}

export const DescribeStreamConsumer = Binding.Service<DescribeStreamConsumer>(
  "AWS.Kinesis.DescribeStreamConsumer",
);
