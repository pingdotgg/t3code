import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:StartTextDetection` — start asynchronous detection of text in a stored video.
 *
 * Rekognition Video jobs read the video from S3 and run asynchronously —
 * poll the paired `Get*` binding with the returned `JobId`, or pass a
 * `NotificationChannel` (SNS topic + IAM role the caller must be allowed
 * to pass) to be notified on completion.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:StartTextDetection` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.StartTextDetectionHttp)`.
 *
 * @binding
 * @section Video Analysis
 * @example Start Text Detection
 * ```typescript
 * // init
 * const startTextDetection = yield* AWS.Rekognition.StartTextDetection();
 *
 * // runtime
 * const started = yield* startTextDetection({
 *   Video: { S3Object: { Bucket: "videos", Name: "input.mp4" } },
 * });
 * // started.JobId
 * ```
 */
export interface StartTextDetection extends Binding.Service<
  StartTextDetection,
  "AWS.Rekognition.StartTextDetection",
  () => Effect.Effect<
    (
      request: rekognition.StartTextDetectionRequest,
    ) => Effect.Effect<
      rekognition.StartTextDetectionResponse,
      rekognition.StartTextDetectionError
    >
  >
> {}
export const StartTextDetection = Binding.Service<StartTextDetection>(
  "AWS.Rekognition.StartTextDetection",
);
