import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:ListRxNormInferenceJobs` — list the asynchronous RxNorm ontology linking jobs you have submitted.
 *
 * Comprehend Medical has no resource-level IAM, so the binding takes no
 * arguments and grants `comprehendmedical:ListRxNormInferenceJobs` on `*`. Provide the
 * implementation with `Effect.provide(AWS.ComprehendMedical.ListRxNormInferenceJobsHttp)`.
 *
 * @binding
 * @section Batch RxNorm Inference Jobs
 * @example List Submitted Jobs
 * ```typescript
 * // init
 * const listRxNormInferenceJobs = yield* AWS.ComprehendMedical.ListRxNormInferenceJobs();
 *
 * // runtime
 * const jobs = yield* listRxNormInferenceJobs({});
 * console.log(jobs.ComprehendMedicalAsyncJobPropertiesList?.length ?? 0);
 * ```
 */
export interface ListRxNormInferenceJobs extends Binding.Service<
  ListRxNormInferenceJobs,
  "AWS.ComprehendMedical.ListRxNormInferenceJobs",
  () => Effect.Effect<
    (
      request: comprehendmedical.ListRxNormInferenceJobsRequest,
    ) => Effect.Effect<
      comprehendmedical.ListRxNormInferenceJobsResponse,
      comprehendmedical.ListRxNormInferenceJobsError
    >
  >
> {}
export const ListRxNormInferenceJobs = Binding.Service<ListRxNormInferenceJobs>(
  "AWS.ComprehendMedical.ListRxNormInferenceJobs",
);
