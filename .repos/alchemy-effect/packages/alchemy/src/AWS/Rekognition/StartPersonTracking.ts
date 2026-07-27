import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:StartPersonTracking` — start asynchronous detection of the path of persons in a stored video.
 *
 * Rekognition Video jobs read the video from S3 and run asynchronously —
 * poll the paired `Get*` binding with the returned `JobId`, or pass a
 * `NotificationChannel` (SNS topic + IAM role the caller must be allowed
 * to pass) to be notified on completion.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:StartPersonTracking` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.StartPersonTrackingHttp)`.
 *
 * @binding
 * @section Video Analysis
 * @example Start Person Tracking
 * ```typescript
 * // init
 * const startPersonTracking = yield* AWS.Rekognition.StartPersonTracking();
 *
 * // runtime
 * const started = yield* startPersonTracking({
 *   Video: { S3Object: { Bucket: "videos", Name: "input.mp4" } },
 * });
 * // started.JobId
 * ```
 */
export interface StartPersonTracking extends Binding.Service<
  StartPersonTracking,
  "AWS.Rekognition.StartPersonTracking",
  () => Effect.Effect<
    (
      request: rekognition.StartPersonTrackingRequest,
    ) => Effect.Effect<
      rekognition.StartPersonTrackingResponse,
      rekognition.StartPersonTrackingError
    >
  >
> {}
export const StartPersonTracking = Binding.Service<StartPersonTracking>(
  "AWS.Rekognition.StartPersonTracking",
);
