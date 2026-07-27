import type * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `imagebuilder:GetImage`.
 *
 * Reads an image build version by ARN — its state (`BUILDING`, `AVAILABLE`,
 * `CANCELLED`, `FAILED`, …) and the AMIs/containers it produced. Build
 * versions are created dynamically by pipeline runs, so this is an
 * account-level binding: pass the `imageBuildVersionArn` returned by
 * `StartImagePipelineExecution` or found via `ListImagePipelineImages`.
 * Provide the implementation with
 * `Effect.provide(AWS.ImageBuilder.GetImageHttp)`.
 * @binding
 * @section Observing Builds
 * @example Poll a Build's State
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getImage = yield* AWS.ImageBuilder.GetImage();
 *
 * // runtime
 * const { image } = yield* getImage({ imageBuildVersionArn });
 * yield* Effect.log(`build is ${image?.state?.status}`);
 * ```
 */
export interface GetImage extends Binding.Service<
  GetImage,
  "AWS.ImageBuilder.GetImage",
  () => Effect.Effect<
    (
      request: imagebuilder.GetImageRequest,
    ) => Effect.Effect<
      imagebuilder.GetImageResponse,
      imagebuilder.GetImageError
    >
  >
> {}
export const GetImage = Binding.Service<GetImage>("AWS.ImageBuilder.GetImage");
