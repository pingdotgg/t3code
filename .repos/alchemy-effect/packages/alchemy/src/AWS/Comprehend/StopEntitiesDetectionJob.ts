import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:StopEntitiesDetectionJob` — request termination
 * of an in-progress asynchronous entity detection job. The job moves to
 * `STOP_REQUESTED` and then `STOPPED`; documents already processed are
 * written to the output location.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * @binding
 * @section Stopping Analysis Jobs
 * @example Stop a Running EntitiesDetection Job
 * ```typescript
 * // init
 * const stopEntitiesDetectionJob = yield* AWS.Comprehend.StopEntitiesDetectionJob();
 *
 * // runtime
 * const result = yield* stopEntitiesDetectionJob({ JobId: jobId });
 * // result.JobStatus === "STOP_REQUESTED"
 * ```
 */
export interface StopEntitiesDetectionJob extends Binding.Service<
  StopEntitiesDetectionJob,
  "AWS.Comprehend.StopEntitiesDetectionJob",
  () => Effect.Effect<
    (
      request: comprehend.StopEntitiesDetectionJobRequest,
    ) => Effect.Effect<
      comprehend.StopEntitiesDetectionJobResponse,
      comprehend.StopEntitiesDetectionJobError
    >
  >
> {}
export const StopEntitiesDetectionJob =
  Binding.Service<StopEntitiesDetectionJob>(
    "AWS.Comprehend.StopEntitiesDetectionJob",
  );
