import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:DescribePHIDetectionJob` — get the properties and status of an asynchronous protected health information (PHI) detection job.
 *
 * Comprehend Medical has no resource-level IAM, so the binding takes no
 * arguments and grants `comprehendmedical:DescribePHIDetectionJob` on `*`. Provide the
 * implementation with `Effect.provide(AWS.ComprehendMedical.DescribePHIDetectionJobHttp)`.
 *
 * @binding
 * @section Batch PHI Detection Jobs
 * @example Poll a Job's Status
 * ```typescript
 * // init
 * const describePHIDetectionJob = yield* AWS.ComprehendMedical.DescribePHIDetectionJob();
 *
 * // runtime
 * const status = yield* describePHIDetectionJob({ JobId: jobId });
 * console.log(status.ComprehendMedicalAsyncJobProperties?.JobStatus);
 * ```
 */
export interface DescribePHIDetectionJob extends Binding.Service<
  DescribePHIDetectionJob,
  "AWS.ComprehendMedical.DescribePHIDetectionJob",
  () => Effect.Effect<
    (
      request: comprehendmedical.DescribePHIDetectionJobRequest,
    ) => Effect.Effect<
      comprehendmedical.DescribePHIDetectionJobResponse,
      comprehendmedical.DescribePHIDetectionJobError
    >
  >
> {}
export const DescribePHIDetectionJob = Binding.Service<DescribePHIDetectionJob>(
  "AWS.ComprehendMedical.DescribePHIDetectionJob",
);
