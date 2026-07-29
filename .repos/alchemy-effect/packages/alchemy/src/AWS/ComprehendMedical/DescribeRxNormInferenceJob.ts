import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:DescribeRxNormInferenceJob` — get the properties and status of an asynchronous RxNorm ontology linking job.
 *
 * Comprehend Medical has no resource-level IAM, so the binding takes no
 * arguments and grants `comprehendmedical:DescribeRxNormInferenceJob` on `*`. Provide the
 * implementation with `Effect.provide(AWS.ComprehendMedical.DescribeRxNormInferenceJobHttp)`.
 *
 * @binding
 * @section Batch RxNorm Inference Jobs
 * @example Poll a Job's Status
 * ```typescript
 * // init
 * const describeRxNormInferenceJob = yield* AWS.ComprehendMedical.DescribeRxNormInferenceJob();
 *
 * // runtime
 * const status = yield* describeRxNormInferenceJob({ JobId: jobId });
 * console.log(status.ComprehendMedicalAsyncJobProperties?.JobStatus);
 * ```
 */
export interface DescribeRxNormInferenceJob extends Binding.Service<
  DescribeRxNormInferenceJob,
  "AWS.ComprehendMedical.DescribeRxNormInferenceJob",
  () => Effect.Effect<
    (
      request: comprehendmedical.DescribeRxNormInferenceJobRequest,
    ) => Effect.Effect<
      comprehendmedical.DescribeRxNormInferenceJobResponse,
      comprehendmedical.DescribeRxNormInferenceJobError
    >
  >
> {}
export const DescribeRxNormInferenceJob =
  Binding.Service<DescribeRxNormInferenceJob>(
    "AWS.ComprehendMedical.DescribeRxNormInferenceJob",
  );
