import type * as rekognition from "@distilled.cloud/aws/rekognition";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `rekognition:GetMediaAnalysisJob` — get the status and results location of a media analysis job.
 *
 * The binding takes no arguments and grants the function
 * `rekognition:GetMediaAnalysisJob` on `*` (Rekognition data-plane resources such
 * as collections, users, and jobs are routinely created at runtime, so
 * their identifiers are unknown at deploy time). Provide the
 * implementation with `Effect.provide(AWS.Rekognition.GetMediaAnalysisJobHttp)`.
 *
 * @binding
 * @section Media Analysis Jobs
 * @example Poll a Media Analysis Job
 * ```typescript
 * // init
 * const getMediaAnalysisJob = yield* AWS.Rekognition.GetMediaAnalysisJob();
 *
 * // runtime
 * const job = yield* getMediaAnalysisJob({ JobId: jobId });
 * // job.Status, job.Results?.S3Object
 * ```
 */
export interface GetMediaAnalysisJob extends Binding.Service<
  GetMediaAnalysisJob,
  "AWS.Rekognition.GetMediaAnalysisJob",
  () => Effect.Effect<
    (
      request: rekognition.GetMediaAnalysisJobRequest,
    ) => Effect.Effect<
      rekognition.GetMediaAnalysisJobResponse,
      rekognition.GetMediaAnalysisJobError
    >
  >
> {}
export const GetMediaAnalysisJob = Binding.Service<GetMediaAnalysisJob>(
  "AWS.Rekognition.GetMediaAnalysisJob",
);
