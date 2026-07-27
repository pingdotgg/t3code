import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:ListCollections` — list the face collection IDs in the account.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:ListCollections` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.ListCollectionsHttp)`.
 *
 * @binding
 * @section Face Collections
 * @example List Collections
 * ```typescript
 * // init
 * const listCollections = yield* AWS.Rekognition.ListCollections();
 *
 * // runtime
 * const page = yield* listCollections({ MaxResults: 20 });
 * // page.CollectionIds, page.NextToken
 * ```
 */
export interface ListCollections extends Binding.Service<
  ListCollections,
  "AWS.Rekognition.ListCollections",
  () => Effect.Effect<
    (
      request?: rekognition.ListCollectionsRequest,
    ) => Effect.Effect<
      rekognition.ListCollectionsResponse,
      rekognition.ListCollectionsError
    >
  >
> {}
export const ListCollections = Binding.Service<ListCollections>(
  "AWS.Rekognition.ListCollections",
);
