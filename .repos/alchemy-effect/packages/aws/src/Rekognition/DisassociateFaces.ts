import type * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `rekognition:DisassociateFaces` — remove the association between face IDs and a user.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:DisassociateFaces` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.DisassociateFacesHttp)`.
 *
 * ### User Search
 * **Example:** Disassociate Faces from a User
 * ```typescript
 * // init
 * const disassociateFaces = yield* AWS.Rekognition.DisassociateFaces();
 *
 * // runtime
 * const result = yield* disassociateFaces({
 *   CollectionId: "tenant-42",
 *   UserId: userId,
 *   FaceIds: [faceId],
 * });
 * ```
 *
 * @binding
 */
export interface DisassociateFaces extends Binding.Service<
  DisassociateFaces,
  "AWS.Rekognition.DisassociateFaces",
  () => Effect.Effect<
    (
      request: rekognition.DisassociateFacesRequest,
    ) => Effect.Effect<rekognition.DisassociateFacesResponse, rekognition.DisassociateFacesError>
  >
> {}
export const DisassociateFaces = Binding.Service<DisassociateFaces>(
  "AWS.Rekognition.DisassociateFaces",
);
