import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:StopStreamProcessor` — stop a running stream processor.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:StopStreamProcessor` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.StopStreamProcessorHttp)`.
 *
 * @binding
 * @section Stream Processors
 * @example Stop a Stream Processor
 * ```typescript
 * // init
 * const stopStreamProcessor = yield* AWS.Rekognition.StopStreamProcessor();
 *
 * // runtime
 * yield* stopStreamProcessor({ Name: "lobby-camera" });
 * ```
 */
export interface StopStreamProcessor extends Binding.Service<
  StopStreamProcessor,
  "AWS.Rekognition.StopStreamProcessor",
  () => Effect.Effect<
    (
      request: rekognition.StopStreamProcessorRequest,
    ) => Effect.Effect<
      rekognition.StopStreamProcessorResponse,
      rekognition.StopStreamProcessorError
    >
  >
> {}
export const StopStreamProcessor = Binding.Service<StopStreamProcessor>(
  "AWS.Rekognition.StopStreamProcessor",
);
