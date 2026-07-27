import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:StartLabelDetection` — start asynchronous detection of labels (objects, scenes, activities) in a stored video.
 *
 * Rekognition Video jobs read the video from S3 and run asynchronously —
 * poll the paired `Get*` binding with the returned `JobId`, or pass a
 * `NotificationChannel` (SNS topic + IAM role the caller must be allowed
 * to pass) to be notified on completion.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:StartLabelDetection` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.StartLabelDetectionHttp)`.
 *
 * @binding
 * @section Video Analysis
 * @example Start Label Detection
 * ```typescript
 * // init
 * const startLabelDetection = yield* AWS.Rekognition.StartLabelDetection();
 *
 * // runtime
 * const started = yield* startLabelDetection({
 *   Video: { S3Object: { Bucket: "videos", Name: "input.mp4" } },
 * });
 * // started.JobId
 * ```
 */
export interface StartLabelDetection extends Binding.Service<
  StartLabelDetection,
  "AWS.Rekognition.StartLabelDetection",
  () => Effect.Effect<
    (
      request: rekognition.StartLabelDetectionRequest,
    ) => Effect.Effect<
      rekognition.StartLabelDetectionResponse,
      rekognition.StartLabelDetectionError
    >
  >
> {}
export const StartLabelDetection = Binding.Service<StartLabelDetection>(
  "AWS.Rekognition.StartLabelDetection",
);
