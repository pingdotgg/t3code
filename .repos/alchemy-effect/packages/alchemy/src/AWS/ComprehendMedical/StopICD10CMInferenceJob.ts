import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:StopICD10CMInferenceJob` — stop an in-progress asynchronous ICD-10-CM ontology linking job.
 *
 * Comprehend Medical has no resource-level IAM, so the binding takes no
 * arguments and grants `comprehendmedical:StopICD10CMInferenceJob` on `*`. Provide the
 * implementation with `Effect.provide(AWS.ComprehendMedical.StopICD10CMInferenceJobHttp)`.
 *
 * @binding
 * @section Batch ICD-10-CM Inference Jobs
 * @example Stop a Running Job
 * ```typescript
 * // init
 * const stopICD10CMInferenceJob = yield* AWS.ComprehendMedical.StopICD10CMInferenceJob();
 *
 * // runtime
 * yield* stopICD10CMInferenceJob({ JobId: jobId });
 * ```
 */
export interface StopICD10CMInferenceJob extends Binding.Service<
  StopICD10CMInferenceJob,
  "AWS.ComprehendMedical.StopICD10CMInferenceJob",
  () => Effect.Effect<
    (
      request: comprehendmedical.StopICD10CMInferenceJobRequest,
    ) => Effect.Effect<
      comprehendmedical.StopICD10CMInferenceJobResponse,
      comprehendmedical.StopICD10CMInferenceJobError
    >
  >
> {}
export const StopICD10CMInferenceJob = Binding.Service<StopICD10CMInferenceJob>(
  "AWS.ComprehendMedical.StopICD10CMInferenceJob",
);
