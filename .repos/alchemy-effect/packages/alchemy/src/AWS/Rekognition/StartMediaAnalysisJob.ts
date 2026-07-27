import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:StartMediaAnalysisJob` — start an asynchronous media analysis job (e.g. bulk content moderation) over an S3 manifest of images.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:StartMediaAnalysisJob` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.StartMediaAnalysisJobHttp)`.
 *
 * @binding
 * @section Media Analysis Jobs
 * @example Start a Bulk Moderation Job
 * ```typescript
 * // init
 * const startMediaAnalysisJob = yield* AWS.Rekognition.StartMediaAnalysisJob();
 *
 * // runtime
 * const started = yield* startMediaAnalysisJob({
 *   OperationsConfig: { DetectModerationLabels: { MinConfidence: 60 } },
 *   Input: { S3Object: { Bucket: "media", Name: "manifest.jsonl" } },
 *   OutputConfig: { S3Bucket: "media", S3KeyPrefix: "results/" },
 * });
 * // started.JobId
 * ```
 */
export interface StartMediaAnalysisJob extends Binding.Service<
  StartMediaAnalysisJob,
  "AWS.Rekognition.StartMediaAnalysisJob",
  () => Effect.Effect<
    (
      request: rekognition.StartMediaAnalysisJobRequest,
    ) => Effect.Effect<
      rekognition.StartMediaAnalysisJobResponse,
      rekognition.StartMediaAnalysisJobError
    >
  >
> {}
export const StartMediaAnalysisJob = Binding.Service<StartMediaAnalysisJob>(
  "AWS.Rekognition.StartMediaAnalysisJob",
);
