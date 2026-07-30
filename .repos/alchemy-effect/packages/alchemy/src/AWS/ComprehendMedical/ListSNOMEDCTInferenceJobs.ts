import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:ListSNOMEDCTInferenceJobs` — list the asynchronous SNOMED CT ontology linking jobs you have submitted.
 *
 * Comprehend Medical has no resource-level IAM, so the binding takes no
 * arguments and grants `comprehendmedical:ListSNOMEDCTInferenceJobs` on `*`. Provide the
 * implementation with `Effect.provide(AWS.ComprehendMedical.ListSNOMEDCTInferenceJobsHttp)`.
 *
 * @binding
 * @section Batch SNOMED CT Inference Jobs
 * @example List Submitted Jobs
 * ```typescript
 * // init
 * const listSNOMEDCTInferenceJobs = yield* AWS.ComprehendMedical.ListSNOMEDCTInferenceJobs();
 *
 * // runtime
 * const jobs = yield* listSNOMEDCTInferenceJobs({});
 * console.log(jobs.ComprehendMedicalAsyncJobPropertiesList?.length ?? 0);
 * ```
 */
export interface ListSNOMEDCTInferenceJobs extends Binding.Service<
  ListSNOMEDCTInferenceJobs,
  "AWS.ComprehendMedical.ListSNOMEDCTInferenceJobs",
  () => Effect.Effect<
    (
      request: comprehendmedical.ListSNOMEDCTInferenceJobsRequest,
    ) => Effect.Effect<
      comprehendmedical.ListSNOMEDCTInferenceJobsResponse,
      comprehendmedical.ListSNOMEDCTInferenceJobsError
    >
  >
> {}
export const ListSNOMEDCTInferenceJobs =
  Binding.Service<ListSNOMEDCTInferenceJobs>(
    "AWS.ComprehendMedical.ListSNOMEDCTInferenceJobs",
  );
