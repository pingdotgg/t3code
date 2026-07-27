import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:AssociateFaces` — associate up to 100 indexed face IDs with a user.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:AssociateFaces` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.AssociateFacesHttp)`.
 *
 * @binding
 * @section User Search
 * @example Associate Faces with a User
 * ```typescript
 * // init
 * const associateFaces = yield* AWS.Rekognition.AssociateFaces();
 *
 * // runtime
 * const result = yield* associateFaces({
 *   CollectionId: "tenant-42",
 *   UserId: userId,
 *   FaceIds: [faceId],
 * });
 * // result.AssociatedFaces, result.UserStatus
 * ```
 */
export interface AssociateFaces extends Binding.Service<
  AssociateFaces,
  "AWS.Rekognition.AssociateFaces",
  () => Effect.Effect<
    (
      request: rekognition.AssociateFacesRequest,
    ) => Effect.Effect<
      rekognition.AssociateFacesResponse,
      rekognition.AssociateFacesError
    >
  >
> {}
export const AssociateFaces = Binding.Service<AssociateFaces>(
  "AWS.Rekognition.AssociateFaces",
);
