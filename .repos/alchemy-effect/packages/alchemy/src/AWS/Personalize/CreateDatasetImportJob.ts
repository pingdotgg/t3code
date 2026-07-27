import type * as personalize from "@distilled.cloud/aws/personalize";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `personalize:CreateDatasetImportJob` — Starts a bulk import of training data from S3 into a dataset — the
 * first step of the MLOps retraining loop. Grants
 * `personalize:CreateDatasetImportJob` on `*` plus `iam:PassRole`
 * (conditioned to `personalize.amazonaws.com`) for the data-access role
 * the service assumes to read the S3 bucket.
 * Provide the implementation with
 * `Effect.provide(AWS.Personalize.CreateDatasetImportJobHttp)`.
 *
 * @binding
 * @section Retraining Loop
 * @example Import Training Data
 * ```typescript
 * // init
 * const createDatasetImportJob = yield* Personalize.CreateDatasetImportJob();
 *
 * const { datasetImportJobArn } = yield* createDatasetImportJob({
 *   jobName: "nightly-import",
 *   datasetArn,
 *   dataSource: { dataLocation: "s3://training-bucket/interactions.csv" },
 *   roleArn: importRoleArn,
 * });
 * ```
 */
export interface CreateDatasetImportJob extends Binding.Service<
  CreateDatasetImportJob,
  "AWS.Personalize.CreateDatasetImportJob",
  () => Effect.Effect<
    (
      request: personalize.CreateDatasetImportJobRequest,
    ) => Effect.Effect<
      personalize.CreateDatasetImportJobResponse,
      personalize.CreateDatasetImportJobError
    >
  >
> {}
export const CreateDatasetImportJob = Binding.Service<CreateDatasetImportJob>(
  "AWS.Personalize.CreateDatasetImportJob",
);
