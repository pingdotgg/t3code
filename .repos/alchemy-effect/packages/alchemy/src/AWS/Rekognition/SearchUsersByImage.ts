import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:SearchUsersByImage` — search a face collection for users matching the largest face in a supplied image.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:SearchUsersByImage` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.SearchUsersByImageHttp)`.
 *
 * @binding
 * @section User Search
 * @example Search Users by Image
 * ```typescript
 * // init
 * const searchUsersByImage = yield* AWS.Rekognition.SearchUsersByImage();
 *
 * // runtime
 * const result = yield* searchUsersByImage({
 *   CollectionId: "tenant-42",
 *   Image: { Bytes: imageBytes },
 * });
 * const bestUser = result.UserMatches?.[0]?.User?.UserId;
 * ```
 */
export interface SearchUsersByImage extends Binding.Service<
  SearchUsersByImage,
  "AWS.Rekognition.SearchUsersByImage",
  () => Effect.Effect<
    (
      request: rekognition.SearchUsersByImageRequest,
    ) => Effect.Effect<
      rekognition.SearchUsersByImageResponse,
      rekognition.SearchUsersByImageError
    >
  >
> {}
export const SearchUsersByImage = Binding.Service<SearchUsersByImage>(
  "AWS.Rekognition.SearchUsersByImage",
);
