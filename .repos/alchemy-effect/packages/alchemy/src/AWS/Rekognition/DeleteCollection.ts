import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:DeleteCollection` — delete a face collection and all faces stored in it.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:DeleteCollection` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.DeleteCollectionHttp)`.
 *
 * @binding
 * @section Face Collections
 * @example Delete a Tenant Collection
 * ```typescript
 * // init
 * const deleteCollection = yield* AWS.Rekognition.DeleteCollection();
 *
 * // runtime
 * yield* deleteCollection({ CollectionId: `tenant-${tenantId}` }).pipe(
 *   Effect.catchTag("ResourceNotFoundException", () => Effect.void),
 * );
 * ```
 */
export interface DeleteCollection extends Binding.Service<
  DeleteCollection,
  "AWS.Rekognition.DeleteCollection",
  () => Effect.Effect<
    (
      request: rekognition.DeleteCollectionRequest,
    ) => Effect.Effect<
      rekognition.DeleteCollectionResponse,
      rekognition.DeleteCollectionError
    >
  >
> {}
export const DeleteCollection = Binding.Service<DeleteCollection>(
  "AWS.Rekognition.DeleteCollection",
);
