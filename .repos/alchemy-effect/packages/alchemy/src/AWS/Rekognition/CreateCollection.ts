import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:CreateCollection` — create a face collection — e.g. one collection per application tenant, created at runtime.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:CreateCollection` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.CreateCollectionHttp)`.
 *
 * @binding
 * @section Face Collections
 * @example Create a Tenant Collection
 * ```typescript
 * // init
 * const createCollection = yield* AWS.Rekognition.CreateCollection();
 *
 * // runtime
 * const created = yield* createCollection({ CollectionId: `tenant-${tenantId}` });
 * // created.CollectionArn, created.FaceModelVersion
 * ```
 */
export interface CreateCollection extends Binding.Service<
  CreateCollection,
  "AWS.Rekognition.CreateCollection",
  () => Effect.Effect<
    (
      request: rekognition.CreateCollectionRequest,
    ) => Effect.Effect<
      rekognition.CreateCollectionResponse,
      rekognition.CreateCollectionError
    >
  >
> {}
export const CreateCollection = Binding.Service<CreateCollection>(
  "AWS.Rekognition.CreateCollection",
);
