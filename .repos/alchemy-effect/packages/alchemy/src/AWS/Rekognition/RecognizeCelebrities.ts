import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:RecognizeCelebrities` — recognize up to 64 celebrities in an image.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:RecognizeCelebrities` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.RecognizeCelebritiesHttp)`.
 *
 * @binding
 * @section Image Analysis
 * @example Recognize Celebrities in a Photo
 * ```typescript
 * // init
 * const recognizeCelebrities = yield* AWS.Rekognition.RecognizeCelebrities();
 *
 * // runtime
 * const result = yield* recognizeCelebrities({
 *   Image: { S3Object: { Bucket: "photos", Name: "red-carpet.jpg" } },
 * });
 * const names = (result.CelebrityFaces ?? []).map((c) => c.Name);
 * ```
 */
export interface RecognizeCelebrities extends Binding.Service<
  RecognizeCelebrities,
  "AWS.Rekognition.RecognizeCelebrities",
  () => Effect.Effect<
    (
      request: rekognition.RecognizeCelebritiesRequest,
    ) => Effect.Effect<
      rekognition.RecognizeCelebritiesResponse,
      rekognition.RecognizeCelebritiesError
    >
  >
> {}
export const RecognizeCelebrities = Binding.Service<RecognizeCelebrities>(
  "AWS.Rekognition.RecognizeCelebrities",
);
