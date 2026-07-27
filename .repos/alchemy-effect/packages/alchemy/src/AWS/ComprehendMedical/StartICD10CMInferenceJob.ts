import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:StartICD10CMInferenceJob` — start an asynchronous ICD-10-CM ontology linking job over a collection of documents in S3. Also grants `iam:PassRole` (conditioned to `comprehendmedical.amazonaws.com`) for the job's data-access role.
 *
 * Comprehend Medical has no resource-level IAM, so the binding takes no
 * arguments and grants `comprehendmedical:StartICD10CMInferenceJob` on `*`. Provide the
 * implementation with `Effect.provide(AWS.ComprehendMedical.StartICD10CMInferenceJobHttp)`.
 *
 * @binding
 * @section Batch ICD-10-CM Inference Jobs
 * @example Start a Batch Job
 * ```typescript
 * // init
 * const startICD10CMInferenceJob = yield* AWS.ComprehendMedical.StartICD10CMInferenceJob();
 *
 * // runtime
 * const job = yield* startICD10CMInferenceJob({
 *   InputDataConfig: { S3Bucket: "my-input-bucket", S3Key: "notes/" },
 *   OutputDataConfig: { S3Bucket: "my-output-bucket" },
 *   DataAccessRoleArn: dataAccessRole.roleArn,
 *   LanguageCode: "en",
 * });
 * ```
 */
export interface StartICD10CMInferenceJob extends Binding.Service<
  StartICD10CMInferenceJob,
  "AWS.ComprehendMedical.StartICD10CMInferenceJob",
  () => Effect.Effect<
    (
      request: comprehendmedical.StartICD10CMInferenceJobRequest,
    ) => Effect.Effect<
      comprehendmedical.StartICD10CMInferenceJobResponse,
      comprehendmedical.StartICD10CMInferenceJobError
    >
  >
> {}
export const StartICD10CMInferenceJob =
  Binding.Service<StartICD10CMInferenceJob>(
    "AWS.ComprehendMedical.StartICD10CMInferenceJob",
  );
