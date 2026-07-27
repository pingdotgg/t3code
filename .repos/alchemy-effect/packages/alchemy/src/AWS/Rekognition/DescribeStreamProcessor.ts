import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:DescribeStreamProcessor` — describe a stream processor — status, input/output configuration, and settings.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:DescribeStreamProcessor` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.DescribeStreamProcessorHttp)`.
 *
 * @binding
 * @section Stream Processors
 * @example Describe a Stream Processor
 * ```typescript
 * // init
 * const describeStreamProcessor = yield* AWS.Rekognition.DescribeStreamProcessor();
 *
 * // runtime
 * const info = yield* describeStreamProcessor({ Name: "lobby-camera" });
 * // info.Status, info.Input, info.Output
 * ```
 */
export interface DescribeStreamProcessor extends Binding.Service<
  DescribeStreamProcessor,
  "AWS.Rekognition.DescribeStreamProcessor",
  () => Effect.Effect<
    (
      request: rekognition.DescribeStreamProcessorRequest,
    ) => Effect.Effect<
      rekognition.DescribeStreamProcessorResponse,
      rekognition.DescribeStreamProcessorError
    >
  >
> {}
export const DescribeStreamProcessor = Binding.Service<DescribeStreamProcessor>(
  "AWS.Rekognition.DescribeStreamProcessor",
);
