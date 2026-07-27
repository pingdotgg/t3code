import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:StopPiiEntitiesDetectionJob` — request termination
 * of an in-progress asynchronous PII entity detection job. The job moves to
 * `STOP_REQUESTED` and then `STOPPED`; documents already processed are
 * written to the output location.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * @binding
 * @section Stopping Analysis Jobs
 * @example Stop a Running PiiEntitiesDetection Job
 * ```typescript
 * // init
 * const stopPiiEntitiesDetectionJob = yield* AWS.Comprehend.StopPiiEntitiesDetectionJob();
 *
 * // runtime
 * const result = yield* stopPiiEntitiesDetectionJob({ JobId: jobId });
 * // result.JobStatus === "STOP_REQUESTED"
 * ```
 */
export interface StopPiiEntitiesDetectionJob extends Binding.Service<
  StopPiiEntitiesDetectionJob,
  "AWS.Comprehend.StopPiiEntitiesDetectionJob",
  () => Effect.Effect<
    (
      request: comprehend.StopPiiEntitiesDetectionJobRequest,
    ) => Effect.Effect<
      comprehend.StopPiiEntitiesDetectionJobResponse,
      comprehend.StopPiiEntitiesDetectionJobError
    >
  >
> {}
export const StopPiiEntitiesDetectionJob =
  Binding.Service<StopPiiEntitiesDetectionJob>(
    "AWS.Comprehend.StopPiiEntitiesDetectionJob",
  );
