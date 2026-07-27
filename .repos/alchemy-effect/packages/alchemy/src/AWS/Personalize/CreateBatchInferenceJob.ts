import type * as personalize from "@distilled.cloud/aws/personalize";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `personalize:CreateBatchInferenceJob` — Starts a batch inference job that scores a list of users from S3
 * against a solution version and writes recommendations back to S3.
 * Grants `personalize:CreateBatchInferenceJob` on `*` plus
 * `iam:PassRole` (conditioned to `personalize.amazonaws.com`) for the
 * data-access role the service assumes to read/write the buckets.
 * Provide the implementation with
 * `Effect.provide(AWS.Personalize.CreateBatchInferenceJobHttp)`.
 *
 * @binding
 * @section Batch Inference
 * @example Score Users in Batch
 * ```typescript
 * // init
 * const createBatchInferenceJob = yield* Personalize.CreateBatchInferenceJob();
 *
 * const { batchInferenceJobArn } = yield* createBatchInferenceJob({
 *   jobName: "nightly-scores",
 *   solutionVersionArn,
 *   jobInput: { s3DataSource: { path: "s3://bucket/users.json" } },
 *   jobOutput: { s3DataDestination: { path: "s3://bucket/scores/" } },
 *   roleArn: batchRoleArn,
 * });
 * ```
 */
export interface CreateBatchInferenceJob extends Binding.Service<
  CreateBatchInferenceJob,
  "AWS.Personalize.CreateBatchInferenceJob",
  () => Effect.Effect<
    (
      request: personalize.CreateBatchInferenceJobRequest,
    ) => Effect.Effect<
      personalize.CreateBatchInferenceJobResponse,
      personalize.CreateBatchInferenceJobError
    >
  >
> {}
export const CreateBatchInferenceJob = Binding.Service<CreateBatchInferenceJob>(
  "AWS.Personalize.CreateBatchInferenceJob",
);
