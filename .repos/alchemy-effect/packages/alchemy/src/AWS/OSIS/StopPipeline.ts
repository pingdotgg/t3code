import type * as osis from "@distilled.cloud/aws/osis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Pipeline } from "./Pipeline.ts";

/**
 * Runtime binding for `osis:StopPipeline`.
 *
 * Stops the bound {@link Pipeline} — ingestion halts and OCU billing stops
 * (persistent-buffer storage is retained) — e.g. pausing a non-production
 * pipeline outside working hours. The pipeline name is injected from the
 * binding. Provide the implementation with
 * `Effect.provide(AWS.OSIS.StopPipelineHttp)`.
 * @binding
 * @section Controlling a Pipeline
 * @example Pause Ingestion
 * ```typescript
 * // init — bind the operation to the pipeline
 * const stopPipeline = yield* AWS.OSIS.StopPipeline(pipeline);
 *
 * // runtime
 * const { Pipeline } = yield* stopPipeline();
 * // Pipeline?.Status === "STOPPING"
 * ```
 */
export interface StopPipeline extends Binding.Service<
  StopPipeline,
  "AWS.OSIS.StopPipeline",
  (
    pipeline: Pipeline,
  ) => Effect.Effect<
    () => Effect.Effect<osis.StopPipelineResponse, osis.StopPipelineError>
  >
> {}
export const StopPipeline = Binding.Service<StopPipeline>(
  "AWS.OSIS.StopPipeline",
);
