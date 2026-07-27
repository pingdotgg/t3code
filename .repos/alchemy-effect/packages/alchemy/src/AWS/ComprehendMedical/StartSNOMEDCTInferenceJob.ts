import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:StartSNOMEDCTInferenceJob` — start an asynchronous SNOMED CT ontology linking job over a collection of documents in S3. Also grants `iam:PassRole` (conditioned to `comprehendmedical.amazonaws.com`) for the job's data-access role.
 *
 * Comprehend Medical has no resource-level IAM, so the binding takes no
 * arguments and grants `comprehendmedical:StartSNOMEDCTInferenceJob` on `*`. Provide the
 * implementation with `Effect.provide(AWS.ComprehendMedical.StartSNOMEDCTInferenceJobHttp)`.
 *
 * @binding
 * @section Batch SNOMED CT Inference Jobs
 * @example Start a Batch Job
 * ```typescript
 * // init
 * const startSNOMEDCTInferenceJob = yield* AWS.ComprehendMedical.StartSNOMEDCTInferenceJob();
 *
 * // runtime
 * const job = yield* startSNOMEDCTInferenceJob({
 *   InputDataConfig: { S3Bucket: "my-input-bucket", S3Key: "notes/" },
 *   OutputDataConfig: { S3Bucket: "my-output-bucket" },
 *   DataAccessRoleArn: dataAccessRole.roleArn,
 *   LanguageCode: "en",
 * });
 * ```
 */
export interface StartSNOMEDCTInferenceJob extends Binding.Service<
  StartSNOMEDCTInferenceJob,
  "AWS.ComprehendMedical.StartSNOMEDCTInferenceJob",
  () => Effect.Effect<
    (
      request: comprehendmedical.StartSNOMEDCTInferenceJobRequest,
    ) => Effect.Effect<
      comprehendmedical.StartSNOMEDCTInferenceJobResponse,
      comprehendmedical.StartSNOMEDCTInferenceJobError
    >
  >
> {}
export const StartSNOMEDCTInferenceJob =
  Binding.Service<StartSNOMEDCTInferenceJob>(
    "AWS.ComprehendMedical.StartSNOMEDCTInferenceJob",
  );
