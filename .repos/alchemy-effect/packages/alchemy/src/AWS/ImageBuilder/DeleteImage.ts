import type * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `imagebuilder:DeleteImage`.
 *
 * Deletes an image build version record (it does NOT deregister the EC2
 * AMIs or delete the ECR container images the build produced — clean those
 * up separately). Useful for pruning failed or cancelled builds at runtime.
 * Account-level binding: pass the build version's ARN. Provide the
 * implementation with `Effect.provide(AWS.ImageBuilder.DeleteImageHttp)`.
 * @binding
 * @section Running Builds
 * @example Prune a Cancelled Build
 * ```typescript
 * // init — account-level binding, no resource argument
 * const deleteImage = yield* AWS.ImageBuilder.DeleteImage();
 *
 * // runtime
 * yield* deleteImage({ imageBuildVersionArn });
 * ```
 */
export interface DeleteImage extends Binding.Service<
  DeleteImage,
  "AWS.ImageBuilder.DeleteImage",
  () => Effect.Effect<
    (
      request: imagebuilder.DeleteImageRequest,
    ) => Effect.Effect<
      imagebuilder.DeleteImageResponse,
      imagebuilder.DeleteImageError
    >
  >
> {}
export const DeleteImage = Binding.Service<DeleteImage>(
  "AWS.ImageBuilder.DeleteImage",
);
