import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:StartFaceDetection` — start asynchronous detection of faces in a stored video.
 *
 * Rekognition Video jobs read the video from S3 and run asynchronously —
 * poll the paired `Get*` binding with the returned `JobId`, or pass a
 * `NotificationChannel` (SNS topic + IAM role the caller must be allowed
 * to pass) to be notified on completion.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:StartFaceDetection` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.StartFaceDetectionHttp)`.
 *
 * @binding
 * @section Video Analysis
 * @example Start Face Detection
 * ```typescript
 * // init
 * const startFaceDetection = yield* AWS.Rekognition.StartFaceDetection();
 *
 * // runtime
 * const started = yield* startFaceDetection({
 *   Video: { S3Object: { Bucket: "videos", Name: "input.mp4" } },
 * });
 * // started.JobId
 * ```
 */
export interface StartFaceDetection extends Binding.Service<
  StartFaceDetection,
  "AWS.Rekognition.StartFaceDetection",
  () => Effect.Effect<
    (
      request: rekognition.StartFaceDetectionRequest,
    ) => Effect.Effect<
      rekognition.StartFaceDetectionResponse,
      rekognition.StartFaceDetectionError
    >
  >
> {}
export const StartFaceDetection = Binding.Service<StartFaceDetection>(
  "AWS.Rekognition.StartFaceDetection",
);
