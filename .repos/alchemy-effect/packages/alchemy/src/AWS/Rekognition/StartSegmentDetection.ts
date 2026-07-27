import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:StartSegmentDetection` — start asynchronous detection of technical cues and shot segments in a stored video.
 *
 * Rekognition Video jobs read the video from S3 and run asynchronously —
 * poll the paired `Get*` binding with the returned `JobId`, or pass a
 * `NotificationChannel` (SNS topic + IAM role the caller must be allowed
 * to pass) to be notified on completion.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:StartSegmentDetection` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.StartSegmentDetectionHttp)`.
 *
 * @binding
 * @section Video Analysis
 * @example Start Segment Detection
 * ```typescript
 * // init
 * const startSegmentDetection = yield* AWS.Rekognition.StartSegmentDetection();
 *
 * // runtime
 * const started = yield* startSegmentDetection({
 *   Video: { S3Object: { Bucket: "videos", Name: "input.mp4" } },
 * });
 * // started.JobId
 * ```
 */
export interface StartSegmentDetection extends Binding.Service<
  StartSegmentDetection,
  "AWS.Rekognition.StartSegmentDetection",
  () => Effect.Effect<
    (
      request: rekognition.StartSegmentDetectionRequest,
    ) => Effect.Effect<
      rekognition.StartSegmentDetectionResponse,
      rekognition.StartSegmentDetectionError
    >
  >
> {}
export const StartSegmentDetection = Binding.Service<StartSegmentDetection>(
  "AWS.Rekognition.StartSegmentDetection",
);
