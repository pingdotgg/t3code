import type * as osis from "@distilled.cloud/aws/osis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Pipeline } from "./Pipeline.ts";

/**
 * Runtime binding for `osis:StartPipeline`.
 *
 * Starts the bound {@link Pipeline} after it was stopped — e.g. resuming
 * ingestion on a schedule or in response to an operational signal. Starting
 * takes several minutes; the response reports the transitional `STARTING`
 * status. The pipeline name is injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.OSIS.StartPipelineHttp)`.
 * @binding
 * @section Controlling a Pipeline
 * @example Resume Ingestion
 * ```typescript
 * // init — bind the operation to the pipeline
 * const startPipeline = yield* AWS.OSIS.StartPipeline(pipeline);
 *
 * // runtime
 * const { Pipeline } = yield* startPipeline();
 * // Pipeline?.Status === "STARTING"
 * ```
 */
export interface StartPipeline extends Binding.Service<
  StartPipeline,
  "AWS.OSIS.StartPipeline",
  (
    pipeline: Pipeline,
  ) => Effect.Effect<
    () => Effect.Effect<osis.StartPipelineResponse, osis.StartPipelineError>
  >
> {}
export const StartPipeline = Binding.Service<StartPipeline>(
  "AWS.OSIS.StartPipeline",
);
