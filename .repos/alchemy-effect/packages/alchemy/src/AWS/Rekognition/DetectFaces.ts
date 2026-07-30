import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:DetectFaces` — detect the 100 largest faces in an image and return facial landmarks, pose, and optional attributes (age range, emotions, etc.).
 *
 * The binding takes no arguments and grants the function
 * `rekognition:DetectFaces` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.DetectFacesHttp)`.
 *
 * @binding
 * @section Image Analysis
 * @example Detect Faces with All Attributes
 * ```typescript
 * // init
 * const detectFaces = yield* AWS.Rekognition.DetectFaces();
 *
 * // runtime
 * const result = yield* detectFaces({
 *   Image: { Bytes: imageBytes },
 *   Attributes: ["ALL"],
 * });
 * const ages = (result.FaceDetails ?? []).map((f) => f.AgeRange);
 * ```
 */
export interface DetectFaces extends Binding.Service<
  DetectFaces,
  "AWS.Rekognition.DetectFaces",
  () => Effect.Effect<
    (
      request: rekognition.DetectFacesRequest,
    ) => Effect.Effect<
      rekognition.DetectFacesResponse,
      rekognition.DetectFacesError
    >
  >
> {}
export const DetectFaces = Binding.Service<DetectFaces>(
  "AWS.Rekognition.DetectFaces",
);
