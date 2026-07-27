import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:StartContentModeration` — start asynchronous detection of inappropriate or offensive content in a stored video.
 *
 * Rekognition Video jobs read the video from S3 and run asynchronously —
 * poll the paired `Get*` binding with the returned `JobId`, or pass a
 * `NotificationChannel` (SNS topic + IAM role the caller must be allowed
 * to pass) to be notified on completion.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:StartContentModeration` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.StartContentModerationHttp)`.
 *
 * @binding
 * @section Video Analysis
 * @example Start Content Moderation
 * ```typescript
 * // init
 * const startContentModeration = yield* AWS.Rekognition.StartContentModeration();
 *
 * // runtime
 * const started = yield* startContentModeration({
 *   Video: { S3Object: { Bucket: "videos", Name: "input.mp4" } },
 * });
 * // started.JobId
 * ```
 */
export interface StartContentModeration extends Binding.Service<
  StartContentModeration,
  "AWS.Rekognition.StartContentModeration",
  () => Effect.Effect<
    (
      request: rekognition.StartContentModerationRequest,
    ) => Effect.Effect<
      rekognition.StartContentModerationResponse,
      rekognition.StartContentModerationError
    >
  >
> {}
export const StartContentModeration = Binding.Service<StartContentModeration>(
  "AWS.Rekognition.StartContentModeration",
);
