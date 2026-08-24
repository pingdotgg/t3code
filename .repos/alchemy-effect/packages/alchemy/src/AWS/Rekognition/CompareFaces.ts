import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:CompareFaces` — compare the largest face in a source image against faces in a target image and return match confidence.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:CompareFaces` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.CompareFacesHttp)`.
 *
 * @binding
 * @section Image Analysis
 * @example Compare Two Face Images
 * ```typescript
 * // init
 * const compareFaces = yield* AWS.Rekognition.CompareFaces();
 *
 * // runtime
 * const result = yield* compareFaces({
 *   SourceImage: { S3Object: { Bucket: "photos", Name: "id-card.jpg" } },
 *   TargetImage: { S3Object: { Bucket: "photos", Name: "selfie.jpg" } },
 *   SimilarityThreshold: 90,
 * });
 * const matches = result.FaceMatches ?? [];
 * ```
 */
export interface CompareFaces extends Binding.Service<
  CompareFaces,
  "AWS.Rekognition.CompareFaces",
  () => Effect.Effect<
    (
      request: rekognition.CompareFacesRequest,
    ) => Effect.Effect<
      rekognition.CompareFacesResponse,
      rekognition.CompareFacesError
    >
  >
> {}
export const CompareFaces = Binding.Service<CompareFaces>(
  "AWS.Rekognition.CompareFaces",
);
