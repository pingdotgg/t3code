import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:StopTargetedSentimentDetectionJob` — request termination
 * of an in-progress asynchronous targeted-sentiment detection job. The job moves to
 * `STOP_REQUESTED` and then `STOPPED`; documents already processed are
 * written to the output location.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * @binding
 * @section Stopping Analysis Jobs
 * @example Stop a Running TargetedSentimentDetection Job
 * ```typescript
 * // init
 * const stopTargetedSentimentDetectionJob = yield* AWS.Comprehend.StopTargetedSentimentDetectionJob();
 *
 * // runtime
 * const result = yield* stopTargetedSentimentDetectionJob({ JobId: jobId });
 * // result.JobStatus === "STOP_REQUESTED"
 * ```
 */
export interface StopTargetedSentimentDetectionJob extends Binding.Service<
  StopTargetedSentimentDetectionJob,
  "AWS.Comprehend.StopTargetedSentimentDetectionJob",
  () => Effect.Effect<
    (
      request: comprehend.StopTargetedSentimentDetectionJobRequest,
    ) => Effect.Effect<
      comprehend.StopTargetedSentimentDetectionJobResponse,
      comprehend.StopTargetedSentimentDetectionJobError
    >
  >
> {}
export const StopTargetedSentimentDetectionJob =
  Binding.Service<StopTargetedSentimentDetectionJob>(
    "AWS.Comprehend.StopTargetedSentimentDetectionJob",
  );
