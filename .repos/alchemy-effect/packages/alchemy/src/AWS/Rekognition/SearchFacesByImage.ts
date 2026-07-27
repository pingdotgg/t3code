import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:SearchFacesByImage` — search a face collection for faces matching the largest face in a supplied image.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:SearchFacesByImage` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.SearchFacesByImageHttp)`.
 *
 * @binding
 * @section Face Collections
 * @example Search by Image
 * ```typescript
 * // init
 * const searchFacesByImage = yield* AWS.Rekognition.SearchFacesByImage();
 *
 * // runtime
 * const result = yield* searchFacesByImage({
 *   CollectionId: "tenant-42",
 *   Image: { Bytes: imageBytes },
 *   FaceMatchThreshold: 95,
 * });
 * const bestMatch = result.FaceMatches?.[0]?.Face?.ExternalImageId;
 * ```
 */
export interface SearchFacesByImage extends Binding.Service<
  SearchFacesByImage,
  "AWS.Rekognition.SearchFacesByImage",
  () => Effect.Effect<
    (
      request: rekognition.SearchFacesByImageRequest,
    ) => Effect.Effect<
      rekognition.SearchFacesByImageResponse,
      rekognition.SearchFacesByImageError
    >
  >
> {}
export const SearchFacesByImage = Binding.Service<SearchFacesByImage>(
  "AWS.Rekognition.SearchFacesByImage",
);
