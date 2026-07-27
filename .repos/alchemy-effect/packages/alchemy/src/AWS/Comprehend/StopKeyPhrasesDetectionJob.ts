import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:StopKeyPhrasesDetectionJob` — request termination
 * of an in-progress asynchronous key-phrase detection job. The job moves to
 * `STOP_REQUESTED` and then `STOPPED`; documents already processed are
 * written to the output location.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * @binding
 * @section Stopping Analysis Jobs
 * @example Stop a Running KeyPhrasesDetection Job
 * ```typescript
 * // init
 * const stopKeyPhrasesDetectionJob = yield* AWS.Comprehend.StopKeyPhrasesDetectionJob();
 *
 * // runtime
 * const result = yield* stopKeyPhrasesDetectionJob({ JobId: jobId });
 * // result.JobStatus === "STOP_REQUESTED"
 * ```
 */
export interface StopKeyPhrasesDetectionJob extends Binding.Service<
  StopKeyPhrasesDetectionJob,
  "AWS.Comprehend.StopKeyPhrasesDetectionJob",
  () => Effect.Effect<
    (
      request: comprehend.StopKeyPhrasesDetectionJobRequest,
    ) => Effect.Effect<
      comprehend.StopKeyPhrasesDetectionJobResponse,
      comprehend.StopKeyPhrasesDetectionJobError
    >
  >
> {}
export const StopKeyPhrasesDetectionJob =
  Binding.Service<StopKeyPhrasesDetectionJob>(
    "AWS.Comprehend.StopKeyPhrasesDetectionJob",
  );
