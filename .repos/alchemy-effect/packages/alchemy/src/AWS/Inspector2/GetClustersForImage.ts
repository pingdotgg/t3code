import type * as inspector2 from "@distilled.cloud/aws/inspector2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `inspector2:GetClustersForImage`.
 *
 * Returns a list of clusters and metadata associated with an image.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.GetClustersForImageHttp)`.
 * @binding
 * @section Coverage & Vulnerability Intel
 * @example Find Clusters Running an Image
 * ```typescript
 * // init
 * const getClustersForImage = yield* AWS.Inspector2.GetClustersForImage();
 *
 * // runtime
 * const { cluster } = yield* getClustersForImage({
 *   filter: { resourceId: imageResourceId },
 * });
 * ```
 */
export interface GetClustersForImage extends Binding.Service<
  GetClustersForImage,
  "AWS.Inspector2.GetClustersForImage",
  () => Effect.Effect<
    (
      request: inspector2.GetClustersForImageRequest,
    ) => Effect.Effect<
      inspector2.GetClustersForImageResponse,
      inspector2.GetClustersForImageError
    >
  >
> {}
export const GetClustersForImage = Binding.Service<GetClustersForImage>(
  "AWS.Inspector2.GetClustersForImage",
);
