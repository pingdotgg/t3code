import type * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `imagebuilder:ListImages`.
 *
 * Enumerates the image versions you have access to (owned, shared, or
 * Amazon-managed) — e.g. to discover the latest parent image version.
 * Newly created images can take up to two minutes to appear. Provide the
 * implementation with `Effect.provide(AWS.ImageBuilder.ListImagesHttp)`.
 * @binding
 * @section Observing Builds
 * @example List Your Account's Images
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listImages = yield* AWS.ImageBuilder.ListImages();
 *
 * // runtime
 * const { imageVersionList } = yield* listImages({ owner: "Self" });
 * yield* Effect.log(`account has ${imageVersionList?.length ?? 0} images`);
 * ```
 */
export interface ListImages extends Binding.Service<
  ListImages,
  "AWS.ImageBuilder.ListImages",
  () => Effect.Effect<
    (
      request?: imagebuilder.ListImagesRequest,
    ) => Effect.Effect<
      imagebuilder.ListImagesResponse,
      imagebuilder.ListImagesError
    >
  >
> {}
export const ListImages = Binding.Service<ListImages>(
  "AWS.ImageBuilder.ListImages",
);
