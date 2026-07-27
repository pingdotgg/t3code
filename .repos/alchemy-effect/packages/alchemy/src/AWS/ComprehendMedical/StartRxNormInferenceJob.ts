import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:StartRxNormInferenceJob` — start an asynchronous RxNorm ontology linking job over a collection of documents in S3. Also grants `iam:PassRole` (conditioned to `comprehendmedical.amazonaws.com`) for the job's data-access role.
 *
 * Comprehend Medical has no resource-level IAM, so the binding takes no
 * arguments and grants `comprehendmedical:StartRxNormInferenceJob` on `*`. Provide the
 * implementation with `Effect.provide(AWS.ComprehendMedical.StartRxNormInferenceJobHttp)`.
 *
 * @binding
 * @section Batch RxNorm Inference Jobs
 * @example Start a Batch Job
 * ```typescript
 * // init
 * const startRxNormInferenceJob = yield* AWS.ComprehendMedical.StartRxNormInferenceJob();
 *
 * // runtime
 * const job = yield* startRxNormInferenceJob({
 *   InputDataConfig: { S3Bucket: "my-input-bucket", S3Key: "notes/" },
 *   OutputDataConfig: { S3Bucket: "my-output-bucket" },
 *   DataAccessRoleArn: dataAccessRole.roleArn,
 *   LanguageCode: "en",
 * });
 * ```
 */
export interface StartRxNormInferenceJob extends Binding.Service<
  StartRxNormInferenceJob,
  "AWS.ComprehendMedical.StartRxNormInferenceJob",
  () => Effect.Effect<
    (
      request: comprehendmedical.StartRxNormInferenceJobRequest,
    ) => Effect.Effect<
      comprehendmedical.StartRxNormInferenceJobResponse,
      comprehendmedical.StartRxNormInferenceJobError
    >
  >
> {}
export const StartRxNormInferenceJob = Binding.Service<StartRxNormInferenceJob>(
  "AWS.ComprehendMedical.StartRxNormInferenceJob",
);
