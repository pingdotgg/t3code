import type * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ImagePipeline } from "./ImagePipeline.ts";

/**
 * Runtime binding for `imagebuilder:GetImagePipeline`.
 *
 * Reads the bound {@link ImagePipeline}'s current configuration and state —
 * schedule, status, recipe/infrastructure wiring, and the timestamps of the
 * latest and next scheduled runs. The pipeline's ARN is injected from the
 * binding. Provide the implementation with
 * `Effect.provide(AWS.ImageBuilder.GetImagePipelineHttp)`.
 * @binding
 * @section Observing Pipelines
 * @example Read the Bound Pipeline's State
 * ```typescript
 * // init — bind the operation to the pipeline
 * const getPipeline = yield* AWS.ImageBuilder.GetImagePipeline(pipeline);
 *
 * // runtime
 * const { imagePipeline } = yield* getPipeline();
 * yield* Effect.log(
 *   `${imagePipeline?.name}: ${imagePipeline?.status}, last run ${imagePipeline?.dateLastRun}`,
 * );
 * ```
 */
export interface GetImagePipeline extends Binding.Service<
  GetImagePipeline,
  "AWS.ImageBuilder.GetImagePipeline",
  (
    pipeline: ImagePipeline,
  ) => Effect.Effect<
    () => Effect.Effect<
      imagebuilder.GetImagePipelineResponse,
      imagebuilder.GetImagePipelineError
    >
  >
> {}
export const GetImagePipeline = Binding.Service<GetImagePipeline>(
  "AWS.ImageBuilder.GetImagePipeline",
);
