import type * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ImagePipeline } from "./ImagePipeline.ts";

/**
 * Runtime binding for `imagebuilder:ListImagePipelineImages`.
 *
 * Enumerates the image build versions the bound {@link ImagePipeline} has
 * produced — the building block of a "latest AMI from this pipeline" lookup
 * or a build-history dashboard. The pipeline's ARN is injected from the
 * binding. Provide the implementation with
 * `Effect.provide(AWS.ImageBuilder.ListImagePipelineImagesHttp)`.
 * @binding
 * @section Observing Pipelines
 * @example List the Pipeline's Builds
 * ```typescript
 * // init — bind the operation to the pipeline
 * const listBuilds = yield* AWS.ImageBuilder.ListImagePipelineImages(
 *   pipeline,
 * );
 *
 * // runtime
 * const { imageSummaryList } = yield* listBuilds();
 * const available = (imageSummaryList ?? []).filter(
 *   (image) => image.state?.status === "AVAILABLE",
 * );
 * ```
 */
export interface ListImagePipelineImages extends Binding.Service<
  ListImagePipelineImages,
  "AWS.ImageBuilder.ListImagePipelineImages",
  (
    pipeline: ImagePipeline,
  ) => Effect.Effect<
    (
      request?: Omit<
        imagebuilder.ListImagePipelineImagesRequest,
        "imagePipelineArn"
      >,
    ) => Effect.Effect<
      imagebuilder.ListImagePipelineImagesResponse,
      imagebuilder.ListImagePipelineImagesError
    >
  >
> {}
export const ListImagePipelineImages = Binding.Service<ListImagePipelineImages>(
  "AWS.ImageBuilder.ListImagePipelineImages",
);
