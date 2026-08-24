import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:DescribeICD10CMInferenceJob` — get the properties and status of an asynchronous ICD-10-CM ontology linking job.
 *
 * Comprehend Medical has no resource-level IAM, so the binding takes no
 * arguments and grants `comprehendmedical:DescribeICD10CMInferenceJob` on `*`. Provide the
 * implementation with `Effect.provide(AWS.ComprehendMedical.DescribeICD10CMInferenceJobHttp)`.
 *
 * @binding
 * @section Batch ICD-10-CM Inference Jobs
 * @example Poll a Job's Status
 * ```typescript
 * // init
 * const describeICD10CMInferenceJob = yield* AWS.ComprehendMedical.DescribeICD10CMInferenceJob();
 *
 * // runtime
 * const status = yield* describeICD10CMInferenceJob({ JobId: jobId });
 * console.log(status.ComprehendMedicalAsyncJobProperties?.JobStatus);
 * ```
 */
export interface DescribeICD10CMInferenceJob extends Binding.Service<
  DescribeICD10CMInferenceJob,
  "AWS.ComprehendMedical.DescribeICD10CMInferenceJob",
  () => Effect.Effect<
    (
      request: comprehendmedical.DescribeICD10CMInferenceJobRequest,
    ) => Effect.Effect<
      comprehendmedical.DescribeICD10CMInferenceJobResponse,
      comprehendmedical.DescribeICD10CMInferenceJobError
    >
  >
> {}
export const DescribeICD10CMInferenceJob =
  Binding.Service<DescribeICD10CMInferenceJob>(
    "AWS.ComprehendMedical.DescribeICD10CMInferenceJob",
  );
