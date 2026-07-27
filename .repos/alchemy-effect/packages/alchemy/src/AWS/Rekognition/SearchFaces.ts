import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:SearchFaces` — search a face collection for faces matching a face ID already stored in the collection.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:SearchFaces` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.SearchFacesHttp)`.
 *
 * @binding
 * @section Face Collections
 * @example Search by Face ID
 * ```typescript
 * // init
 * const searchFaces = yield* AWS.Rekognition.SearchFaces();
 *
 * // runtime
 * const result = yield* searchFaces({
 *   CollectionId: "tenant-42",
 *   FaceId: faceId,
 *   FaceMatchThreshold: 95,
 * });
 * const matches = result.FaceMatches ?? [];
 * ```
 */
export interface SearchFaces extends Binding.Service<
  SearchFaces,
  "AWS.Rekognition.SearchFaces",
  () => Effect.Effect<
    (
      request: rekognition.SearchFacesRequest,
    ) => Effect.Effect<
      rekognition.SearchFacesResponse,
      rekognition.SearchFacesError
    >
  >
> {}
export const SearchFaces = Binding.Service<SearchFaces>(
  "AWS.Rekognition.SearchFaces",
);
