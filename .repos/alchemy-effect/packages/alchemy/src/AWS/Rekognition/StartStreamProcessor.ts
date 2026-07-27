import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:StartStreamProcessor` — start a stream processor that analyzes a Kinesis Video Stream (face search or connected-home label detection).
 *
 * The binding takes no arguments and grants the function
 * `rekognition:StartStreamProcessor` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.StartStreamProcessorHttp)`.
 *
 * @binding
 * @section Stream Processors
 * @example Start a Stream Processor
 * ```typescript
 * // init
 * const startStreamProcessor = yield* AWS.Rekognition.StartStreamProcessor();
 *
 * // runtime
 * const started = yield* startStreamProcessor({ Name: "lobby-camera" });
 * // started.SessionId (connected-home processors)
 * ```
 */
export interface StartStreamProcessor extends Binding.Service<
  StartStreamProcessor,
  "AWS.Rekognition.StartStreamProcessor",
  () => Effect.Effect<
    (
      request: rekognition.StartStreamProcessorRequest,
    ) => Effect.Effect<
      rekognition.StartStreamProcessorResponse,
      rekognition.StartStreamProcessorError
    >
  >
> {}
export const StartStreamProcessor = Binding.Service<StartStreamProcessor>(
  "AWS.Rekognition.StartStreamProcessor",
);
