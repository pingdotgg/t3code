import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:StartCelebrityRecognition` — start asynchronous detection of celebrities in a stored video.
 *
 * Rekognition Video jobs read the video from S3 and run asynchronously —
 * poll the paired `Get*` binding with the returned `JobId`, or pass a
 * `NotificationChannel` (SNS topic + IAM role the caller must be allowed
 * to pass) to be notified on completion.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:StartCelebrityRecognition` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.StartCelebrityRecognitionHttp)`.
 *
 * @binding
 * @section Video Analysis
 * @example Start Celebrity Recognition
 * ```typescript
 * // init
 * const startCelebrityRecognition = yield* AWS.Rekognition.StartCelebrityRecognition();
 *
 * // runtime
 * const started = yield* startCelebrityRecognition({
 *   Video: { S3Object: { Bucket: "videos", Name: "input.mp4" } },
 * });
 * // started.JobId
 * ```
 */
export interface StartCelebrityRecognition extends Binding.Service<
  StartCelebrityRecognition,
  "AWS.Rekognition.StartCelebrityRecognition",
  () => Effect.Effect<
    (
      request: rekognition.StartCelebrityRecognitionRequest,
    ) => Effect.Effect<
      rekognition.StartCelebrityRecognitionResponse,
      rekognition.StartCelebrityRecognitionError
    >
  >
> {}
export const StartCelebrityRecognition =
  Binding.Service<StartCelebrityRecognition>(
    "AWS.Rekognition.StartCelebrityRecognition",
  );
