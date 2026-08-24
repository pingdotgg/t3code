import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:GetFaceDetection` — get the results of an asynchronous faces detection job started by StartFaceDetection.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:GetFaceDetection` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.GetFaceDetectionHttp)`.
 *
 * @binding
 * @section Video Analysis
 * @example Poll Face Detection Results
 * ```typescript
 * // init
 * const getFaceDetection = yield* AWS.Rekognition.GetFaceDetection();
 *
 * // runtime
 * const results = yield* getFaceDetection({ JobId: jobId });
 * if (results.JobStatus === "SUCCEEDED") {
 *   // consume the detections
 * }
 * ```
 */
export interface GetFaceDetection extends Binding.Service<
  GetFaceDetection,
  "AWS.Rekognition.GetFaceDetection",
  () => Effect.Effect<
    (
      request: rekognition.GetFaceDetectionRequest,
    ) => Effect.Effect<
      rekognition.GetFaceDetectionResponse,
      rekognition.GetFaceDetectionError
    >
  >
> {}
export const GetFaceDetection = Binding.Service<GetFaceDetection>(
  "AWS.Rekognition.GetFaceDetection",
);
