import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `comprehendmedical:StopPHIDetectionJob` — stop an in-progress asynchronous protected health information (PHI) detection job.
 *
 * Comprehend Medical has no resource-level IAM, so the binding takes no
 * arguments and grants `comprehendmedical:StopPHIDetectionJob` on `*`. Provide the
 * implementation with `Effect.provide(AWS.ComprehendMedical.StopPHIDetectionJobHttp)`.
 *
 * ### Batch PHI Detection Jobs
 * **Example:** Stop a Running Job
 * ```typescript
 * // init
 * const stopPHIDetectionJob = yield* AWS.ComprehendMedical.StopPHIDetectionJob();
 *
 * // runtime
 * yield* stopPHIDetectionJob({ JobId: jobId });
 * ```
 *
 * @binding
 */
export interface StopPHIDetectionJob extends Binding.Service<
  StopPHIDetectionJob,
  "AWS.ComprehendMedical.StopPHIDetectionJob",
  () => Effect.Effect<
    (
      request: comprehendmedical.StopPHIDetectionJobRequest,
    ) => Effect.Effect<
      comprehendmedical.StopPHIDetectionJobResponse,
      comprehendmedical.StopPHIDetectionJobError
    >
  >
> {}
export const StopPHIDetectionJob = Binding.Service<StopPHIDetectionJob>(
  "AWS.ComprehendMedical.StopPHIDetectionJob",
);
