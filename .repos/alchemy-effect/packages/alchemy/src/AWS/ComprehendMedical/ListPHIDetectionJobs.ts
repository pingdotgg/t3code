import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:ListPHIDetectionJobs` — list the asynchronous protected health information (PHI) detection jobs you have submitted.
 *
 * Comprehend Medical has no resource-level IAM, so the binding takes no
 * arguments and grants `comprehendmedical:ListPHIDetectionJobs` on `*`. Provide the
 * implementation with `Effect.provide(AWS.ComprehendMedical.ListPHIDetectionJobsHttp)`.
 *
 * @binding
 * @section Batch PHI Detection Jobs
 * @example List Submitted Jobs
 * ```typescript
 * // init
 * const listPHIDetectionJobs = yield* AWS.ComprehendMedical.ListPHIDetectionJobs();
 *
 * // runtime
 * const jobs = yield* listPHIDetectionJobs({});
 * console.log(jobs.ComprehendMedicalAsyncJobPropertiesList?.length ?? 0);
 * ```
 */
export interface ListPHIDetectionJobs extends Binding.Service<
  ListPHIDetectionJobs,
  "AWS.ComprehendMedical.ListPHIDetectionJobs",
  () => Effect.Effect<
    (
      request: comprehendmedical.ListPHIDetectionJobsRequest,
    ) => Effect.Effect<
      comprehendmedical.ListPHIDetectionJobsResponse,
      comprehendmedical.ListPHIDetectionJobsError
    >
  >
> {}
export const ListPHIDetectionJobs = Binding.Service<ListPHIDetectionJobs>(
  "AWS.ComprehendMedical.ListPHIDetectionJobs",
);
