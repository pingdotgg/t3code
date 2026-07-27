import type * as osis from "@distilled.cloud/aws/osis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Pipeline } from "./Pipeline.ts";

/**
 * Runtime binding for `osis:GetPipeline`.
 *
 * Reads the bound {@link Pipeline}'s live detail — status, capacity, ingest
 * endpoint URLs, and destinations — so an ops function can health-check the
 * pipeline or discover its ingest endpoints at runtime. The pipeline name is
 * injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.OSIS.GetPipelineHttp)`.
 * @binding
 * @section Monitoring a Pipeline
 * @example Check the Pipeline's Status
 * ```typescript
 * // init — bind the operation to the pipeline
 * const getPipeline = yield* AWS.OSIS.GetPipeline(pipeline);
 *
 * // runtime
 * const { Pipeline } = yield* getPipeline();
 * if (Pipeline?.Status !== "ACTIVE") {
 *   yield* Effect.logWarning(`pipeline is ${Pipeline?.Status}`);
 * }
 * ```
 */
export interface GetPipeline extends Binding.Service<
  GetPipeline,
  "AWS.OSIS.GetPipeline",
  (
    pipeline: Pipeline,
  ) => Effect.Effect<
    () => Effect.Effect<osis.GetPipelineResponse, osis.GetPipelineError>
  >
> {}
export const GetPipeline = Binding.Service<GetPipeline>("AWS.OSIS.GetPipeline");
