import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:StopRxNormInferenceJob` — stop an in-progress asynchronous RxNorm ontology linking job.
 *
 * Comprehend Medical has no resource-level IAM, so the binding takes no
 * arguments and grants `comprehendmedical:StopRxNormInferenceJob` on `*`. Provide the
 * implementation with `Effect.provide(AWS.ComprehendMedical.StopRxNormInferenceJobHttp)`.
 *
 * @binding
 * @section Batch RxNorm Inference Jobs
 * @example Stop a Running Job
 * ```typescript
 * // init
 * const stopRxNormInferenceJob = yield* AWS.ComprehendMedical.StopRxNormInferenceJob();
 *
 * // runtime
 * yield* stopRxNormInferenceJob({ JobId: jobId });
 * ```
 */
export interface StopRxNormInferenceJob extends Binding.Service<
  StopRxNormInferenceJob,
  "AWS.ComprehendMedical.StopRxNormInferenceJob",
  () => Effect.Effect<
    (
      request: comprehendmedical.StopRxNormInferenceJobRequest,
    ) => Effect.Effect<
      comprehendmedical.StopRxNormInferenceJobResponse,
      comprehendmedical.StopRxNormInferenceJobError
    >
  >
> {}
export const StopRxNormInferenceJob = Binding.Service<StopRxNormInferenceJob>(
  "AWS.ComprehendMedical.StopRxNormInferenceJob",
);
