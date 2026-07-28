import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:DeleteFaces` — delete faces from a face collection by face ID.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:DeleteFaces` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.DeleteFacesHttp)`.
 *
 * @binding
 * @section Face Collections
 * @example Delete Faces from a Collection
 * ```typescript
 * // init
 * const deleteFaces = yield* AWS.Rekognition.DeleteFaces();
 *
 * // runtime
 * const result = yield* deleteFaces({
 *   CollectionId: "tenant-42",
 *   FaceIds: [faceId],
 * });
 * // result.DeletedFaces, result.UnsuccessfulFaceDeletions
 * ```
 */
export interface DeleteFaces extends Binding.Service<
  DeleteFaces,
  "AWS.Rekognition.DeleteFaces",
  () => Effect.Effect<
    (
      request: rekognition.DeleteFacesRequest,
    ) => Effect.Effect<
      rekognition.DeleteFacesResponse,
      rekognition.DeleteFacesError
    >
  >
> {}
export const DeleteFaces = Binding.Service<DeleteFaces>(
  "AWS.Rekognition.DeleteFaces",
);
