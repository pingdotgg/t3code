import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:DescribeSNOMEDCTInferenceJob` — get the properties and status of an asynchronous SNOMED CT ontology linking job.
 *
 * Comprehend Medical has no resource-level IAM, so the binding takes no
 * arguments and grants `comprehendmedical:DescribeSNOMEDCTInferenceJob` on `*`. Provide the
 * implementation with `Effect.provide(AWS.ComprehendMedical.DescribeSNOMEDCTInferenceJobHttp)`.
 *
 * @binding
 * @section Batch SNOMED CT Inference Jobs
 * @example Poll a Job's Status
 * ```typescript
 * // init
 * const describeSNOMEDCTInferenceJob = yield* AWS.ComprehendMedical.DescribeSNOMEDCTInferenceJob();
 *
 * // runtime
 * const status = yield* describeSNOMEDCTInferenceJob({ JobId: jobId });
 * console.log(status.ComprehendMedicalAsyncJobProperties?.JobStatus);
 * ```
 */
export interface DescribeSNOMEDCTInferenceJob extends Binding.Service<
  DescribeSNOMEDCTInferenceJob,
  "AWS.ComprehendMedical.DescribeSNOMEDCTInferenceJob",
  () => Effect.Effect<
    (
      request: comprehendmedical.DescribeSNOMEDCTInferenceJobRequest,
    ) => Effect.Effect<
      comprehendmedical.DescribeSNOMEDCTInferenceJobResponse,
      comprehendmedical.DescribeSNOMEDCTInferenceJobError
    >
  >
> {}
export const DescribeSNOMEDCTInferenceJob =
  Binding.Service<DescribeSNOMEDCTInferenceJob>(
    "AWS.ComprehendMedical.DescribeSNOMEDCTInferenceJob",
  );
