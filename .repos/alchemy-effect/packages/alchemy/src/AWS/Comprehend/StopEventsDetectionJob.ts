import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:StopEventsDetectionJob` — request termination
 * of an in-progress asynchronous event detection job. The job moves to
 * `STOP_REQUESTED` and then `STOPPED`; documents already processed are
 * written to the output location.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * @binding
 * @section Stopping Analysis Jobs
 * @example Stop a Running EventsDetection Job
 * ```typescript
 * // init
 * const stopEventsDetectionJob = yield* AWS.Comprehend.StopEventsDetectionJob();
 *
 * // runtime
 * const result = yield* stopEventsDetectionJob({ JobId: jobId });
 * // result.JobStatus === "STOP_REQUESTED"
 * ```
 */
export interface StopEventsDetectionJob extends Binding.Service<
  StopEventsDetectionJob,
  "AWS.Comprehend.StopEventsDetectionJob",
  () => Effect.Effect<
    (
      request: comprehend.StopEventsDetectionJobRequest,
    ) => Effect.Effect<
      comprehend.StopEventsDetectionJobResponse,
      comprehend.StopEventsDetectionJobError
    >
  >
> {}
export const StopEventsDetectionJob = Binding.Service<StopEventsDetectionJob>(
  "AWS.Comprehend.StopEventsDetectionJob",
);
