import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:ListFaces` — list the metadata of faces stored in a face collection.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:ListFaces` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.ListFacesHttp)`.
 *
 * @binding
 * @section Face Collections
 * @example List Faces in a Collection
 * ```typescript
 * // init
 * const listFaces = yield* AWS.Rekognition.ListFaces();
 *
 * // runtime
 * const page = yield* listFaces({ CollectionId: "tenant-42", MaxResults: 100 });
 * // page.Faces, page.NextToken
 * ```
 */
export interface ListFaces extends Binding.Service<
  ListFaces,
  "AWS.Rekognition.ListFaces",
  () => Effect.Effect<
    (
      request: rekognition.ListFacesRequest,
    ) => Effect.Effect<
      rekognition.ListFacesResponse,
      rekognition.ListFacesError
    >
  >
> {}
export const ListFaces = Binding.Service<ListFaces>(
  "AWS.Rekognition.ListFaces",
);
