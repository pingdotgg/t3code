import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:StopSentimentDetectionJob` — request termination
 * of an in-progress asynchronous sentiment detection job. The job moves to
 * `STOP_REQUESTED` and then `STOPPED`; documents already processed are
 * written to the output location.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * @binding
 * @section Stopping Analysis Jobs
 * @example Stop a Running SentimentDetection Job
 * ```typescript
 * // init
 * const stopSentimentDetectionJob = yield* AWS.Comprehend.StopSentimentDetectionJob();
 *
 * // runtime
 * const result = yield* stopSentimentDetectionJob({ JobId: jobId });
 * // result.JobStatus === "STOP_REQUESTED"
 * ```
 */
export interface StopSentimentDetectionJob extends Binding.Service<
  StopSentimentDetectionJob,
  "AWS.Comprehend.StopSentimentDetectionJob",
  () => Effect.Effect<
    (
      request: comprehend.StopSentimentDetectionJobRequest,
    ) => Effect.Effect<
      comprehend.StopSentimentDetectionJobResponse,
      comprehend.StopSentimentDetectionJobError
    >
  >
> {}
export const StopSentimentDetectionJob =
  Binding.Service<StopSentimentDetectionJob>(
    "AWS.Comprehend.StopSentimentDetectionJob",
  );
