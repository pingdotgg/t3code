import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:ListICD10CMInferenceJobs` — list the asynchronous ICD-10-CM ontology linking jobs you have submitted.
 *
 * Comprehend Medical has no resource-level IAM, so the binding takes no
 * arguments and grants `comprehendmedical:ListICD10CMInferenceJobs` on `*`. Provide the
 * implementation with `Effect.provide(AWS.ComprehendMedical.ListICD10CMInferenceJobsHttp)`.
 *
 * @binding
 * @section Batch ICD-10-CM Inference Jobs
 * @example List Submitted Jobs
 * ```typescript
 * // init
 * const listICD10CMInferenceJobs = yield* AWS.ComprehendMedical.ListICD10CMInferenceJobs();
 *
 * // runtime
 * const jobs = yield* listICD10CMInferenceJobs({});
 * console.log(jobs.ComprehendMedicalAsyncJobPropertiesList?.length ?? 0);
 * ```
 */
export interface ListICD10CMInferenceJobs extends Binding.Service<
  ListICD10CMInferenceJobs,
  "AWS.ComprehendMedical.ListICD10CMInferenceJobs",
  () => Effect.Effect<
    (
      request: comprehendmedical.ListICD10CMInferenceJobsRequest,
    ) => Effect.Effect<
      comprehendmedical.ListICD10CMInferenceJobsResponse,
      comprehendmedical.ListICD10CMInferenceJobsError
    >
  >
> {}
export const ListICD10CMInferenceJobs =
  Binding.Service<ListICD10CMInferenceJobs>(
    "AWS.ComprehendMedical.ListICD10CMInferenceJobs",
  );
