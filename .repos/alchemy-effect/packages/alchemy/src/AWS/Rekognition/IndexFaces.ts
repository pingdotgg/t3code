import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:IndexFaces` — detect faces in an image and add them to a face collection for later search.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:IndexFaces` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.IndexFacesHttp)`.
 *
 * @binding
 * @section Face Collections
 * @example Index Faces into a Collection
 * ```typescript
 * // init
 * const indexFaces = yield* AWS.Rekognition.IndexFaces();
 *
 * // runtime
 * const result = yield* indexFaces({
 *   CollectionId: "tenant-42",
 *   Image: { S3Object: { Bucket: "photos", Name: "profile.jpg" } },
 *   ExternalImageId: userId,
 * });
 * const faceIds = (result.FaceRecords ?? []).map((r) => r.Face?.FaceId);
 * ```
 */
export interface IndexFaces extends Binding.Service<
  IndexFaces,
  "AWS.Rekognition.IndexFaces",
  () => Effect.Effect<
    (
      request: rekognition.IndexFacesRequest,
    ) => Effect.Effect<
      rekognition.IndexFacesResponse,
      rekognition.IndexFacesError
    >
  >
> {}
export const IndexFaces = Binding.Service<IndexFaces>(
  "AWS.Rekognition.IndexFaces",
);
