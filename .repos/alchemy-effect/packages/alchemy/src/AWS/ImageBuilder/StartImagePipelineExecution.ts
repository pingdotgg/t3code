import type * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ImagePipeline } from "./ImagePipeline.ts";

/**
 * Runtime binding for `imagebuilder:StartImagePipelineExecution`.
 *
 * Manually kicks off a build of the bound {@link ImagePipeline} — the
 * pipeline's ARN is injected and the idempotency `clientToken` is generated
 * automatically. Returns the `imageBuildVersionArn` of the image being
 * created, for use with `GetImage` / `CancelImageCreation`. Provide the
 * implementation with
 * `Effect.provide(AWS.ImageBuilder.StartImagePipelineExecutionHttp)`.
 * @binding
 * @section Running Builds
 * @example Start a Build of the Bound Pipeline
 * ```typescript
 * // init — bind the operation to the pipeline
 * const startBuild = yield* AWS.ImageBuilder.StartImagePipelineExecution(
 *   pipeline,
 * );
 *
 * // runtime
 * const { imageBuildVersionArn } = yield* startBuild();
 * yield* Effect.log(`building ${imageBuildVersionArn}`);
 * ```
 */
export interface StartImagePipelineExecution extends Binding.Service<
  StartImagePipelineExecution,
  "AWS.ImageBuilder.StartImagePipelineExecution",
  (
    pipeline: ImagePipeline,
  ) => Effect.Effect<
    (
      request?: Omit<
        imagebuilder.StartImagePipelineExecutionRequest,
        "imagePipelineArn" | "clientToken"
      >,
    ) => Effect.Effect<
      imagebuilder.StartImagePipelineExecutionResponse,
      imagebuilder.StartImagePipelineExecutionError
    >
  >
> {}
export const StartImagePipelineExecution =
  Binding.Service<StartImagePipelineExecution>(
    "AWS.ImageBuilder.StartImagePipelineExecution",
  );
