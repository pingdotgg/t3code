import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:StartPHIDetectionJob` — start an asynchronous protected health information (PHI) detection job over a collection of documents in S3. Also grants `iam:PassRole` (conditioned to `comprehendmedical.amazonaws.com`) for the job's data-access role.
 *
 * Comprehend Medical has no resource-level IAM, so the binding takes no
 * arguments and grants `comprehendmedical:StartPHIDetectionJob` on `*`. Provide the
 * implementation with `Effect.provide(AWS.ComprehendMedical.StartPHIDetectionJobHttp)`.
 *
 * @binding
 * @section Batch PHI Detection Jobs
 * @example Start a Batch Job
 * ```typescript
 * // init
 * const startPHIDetectionJob = yield* AWS.ComprehendMedical.StartPHIDetectionJob();
 *
 * // runtime
 * const job = yield* startPHIDetectionJob({
 *   InputDataConfig: { S3Bucket: "my-input-bucket", S3Key: "notes/" },
 *   OutputDataConfig: { S3Bucket: "my-output-bucket" },
 *   DataAccessRoleArn: dataAccessRole.roleArn,
 *   LanguageCode: "en",
 * });
 * ```
 */
export interface StartPHIDetectionJob extends Binding.Service<
  StartPHIDetectionJob,
  "AWS.ComprehendMedical.StartPHIDetectionJob",
  () => Effect.Effect<
    (
      request: comprehendmedical.StartPHIDetectionJobRequest,
    ) => Effect.Effect<
      comprehendmedical.StartPHIDetectionJobResponse,
      comprehendmedical.StartPHIDetectionJobError
    >
  >
> {}
export const StartPHIDetectionJob = Binding.Service<StartPHIDetectionJob>(
  "AWS.ComprehendMedical.StartPHIDetectionJob",
);
