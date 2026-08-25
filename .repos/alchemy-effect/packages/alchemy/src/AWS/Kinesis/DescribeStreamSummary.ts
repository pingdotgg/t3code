import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface DescribeStreamSummaryRequest extends Omit<
  Kinesis.DescribeStreamSummaryInput,
  "StreamName" | "StreamARN"
> {}

/**
 * Runtime binding for `kinesis:DescribeStreamSummary`.
 *
 * Bind this operation to a `Stream` to read its status, mode, retention,
 * encryption, and open shard count without paginating the full shard map.
 * Provide the implementation with
 * `Effect.provide(AWS.Kinesis.DescribeStreamSummaryHttp)`.
 * @binding
 * @section Inspecting Streams
 * @example Read the Stream Summary
 * ```typescript
 * // init
 * const describeStreamSummary = yield* AWS.Kinesis.DescribeStreamSummary(stream);
 *
 * // runtime
 * const result = yield* describeStreamSummary();
 * const summary = result.StreamDescriptionSummary;
 * yield* Effect.log(`${summary.StreamStatus}: ${summary.OpenShardCount} shards`);
 * ```
 */
export interface DescribeStreamSummary extends Binding.Service<
  DescribeStreamSummary,
  "AWS.Kinesis.DescribeStreamSummary",
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request?: DescribeStreamSummaryRequest,
    ) => Effect.Effect<
      Kinesis.DescribeStreamSummaryOutput,
      Kinesis.DescribeStreamSummaryError
    >
  >
> {}

export const DescribeStreamSummary = Binding.Service<DescribeStreamSummary>(
  "AWS.Kinesis.DescribeStreamSummary",
);
