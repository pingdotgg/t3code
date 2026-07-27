import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Stream } from "./Stream.ts";

export interface DescribeStreamRequest extends Omit<
  Kinesis.DescribeStreamInput,
  "StreamName" | "StreamARN"
> {}

/**
 * Runtime binding for `kinesis:DescribeStream`.
 *
 * Bind this operation to a `Stream` to read its full description, including
 * the shard map — the stream name is injected automatically. For status and
 * counts without the shard list, prefer `AWS.Kinesis.DescribeStreamSummary`.
 * Provide the implementation with
 * `Effect.provide(AWS.Kinesis.DescribeStreamHttp)`.
 * @binding
 * @section Inspecting Streams
 * @example Describe the Bound Stream
 * ```typescript
 * // init
 * const describeStream = yield* AWS.Kinesis.DescribeStream(stream);
 *
 * // runtime
 * const result = yield* describeStream();
 * const status = result.StreamDescription.StreamStatus;
 * const shards = result.StreamDescription.Shards;
 * ```
 */
export interface DescribeStream extends Binding.Service<
  DescribeStream,
  "AWS.Kinesis.DescribeStream",
  (
    stream: Stream,
  ) => Effect.Effect<
    (
      request?: DescribeStreamRequest,
    ) => Effect.Effect<
      Kinesis.DescribeStreamOutput,
      Kinesis.DescribeStreamError
    >
  >
> {}

export const DescribeStream = Binding.Service<DescribeStream>(
  "AWS.Kinesis.DescribeStream",
);
