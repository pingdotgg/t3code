import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:StopSNOMEDCTInferenceJob` — stop an in-progress asynchronous SNOMED CT ontology linking job.
 *
 * Comprehend Medical has no resource-level IAM, so the binding takes no
 * arguments and grants `comprehendmedical:StopSNOMEDCTInferenceJob` on `*`. Provide the
 * implementation with `Effect.provide(AWS.ComprehendMedical.StopSNOMEDCTInferenceJobHttp)`.
 *
 * @binding
 * @section Batch SNOMED CT Inference Jobs
 * @example Stop a Running Job
 * ```typescript
 * // init
 * const stopSNOMEDCTInferenceJob = yield* AWS.ComprehendMedical.StopSNOMEDCTInferenceJob();
 *
 * // runtime
 * yield* stopSNOMEDCTInferenceJob({ JobId: jobId });
 * ```
 */
export interface StopSNOMEDCTInferenceJob extends Binding.Service<
  StopSNOMEDCTInferenceJob,
  "AWS.ComprehendMedical.StopSNOMEDCTInferenceJob",
  () => Effect.Effect<
    (
      request: comprehendmedical.StopSNOMEDCTInferenceJobRequest,
    ) => Effect.Effect<
      comprehendmedical.StopSNOMEDCTInferenceJobResponse,
      comprehendmedical.StopSNOMEDCTInferenceJobError
    >
  >
> {}
export const StopSNOMEDCTInferenceJob =
  Binding.Service<StopSNOMEDCTInferenceJob>(
    "AWS.ComprehendMedical.StopSNOMEDCTInferenceJob",
  );
