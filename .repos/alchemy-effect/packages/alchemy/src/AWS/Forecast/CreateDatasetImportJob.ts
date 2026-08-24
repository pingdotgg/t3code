import type * as forecast from "@distilled.cloud/aws/forecast";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `forecast:CreateDatasetImportJob` — start an
 * asynchronous import of training data from S3 into a Forecast dataset, the
 * standard scheduled-ingest step of a grandfathered Forecast deployment.
 * Also grants `iam:PassRole` (conditioned to `forecast.amazonaws.com`) for
 * the S3 data-access role the import assumes.
 *
 * The import job's ARN is created at runtime, so the binding takes no
 * arguments and grants `forecast:CreateDatasetImportJob` on `*`. Provide the
 * implementation with `Effect.provide(AWS.Forecast.CreateDatasetImportJobHttp)`.
 *
 * @binding
 * @section Importing Data
 * @example Start a Scheduled Import
 * ```typescript
 * // init
 * const createDatasetImportJob = yield* AWS.Forecast.CreateDatasetImportJob();
 *
 * // runtime
 * const job = yield* createDatasetImportJob({
 *   DatasetImportJobName: "daily_2026_07_14",
 *   DatasetArn: dataset.datasetArn,
 *   DataSource: {
 *     S3Config: {
 *       Path: "s3://my-bucket/demand.csv",
 *       RoleArn: dataAccessRole.roleArn,
 *     },
 *   },
 *   TimestampFormat: "yyyy-MM-dd",
 * });
 * ```
 */
export interface CreateDatasetImportJob extends Binding.Service<
  CreateDatasetImportJob,
  "AWS.Forecast.CreateDatasetImportJob",
  () => Effect.Effect<
    (
      request: forecast.CreateDatasetImportJobRequest,
    ) => Effect.Effect<
      forecast.CreateDatasetImportJobResponse,
      forecast.CreateDatasetImportJobError
    >
  >
> {}
export const CreateDatasetImportJob = Binding.Service<CreateDatasetImportJob>(
  "AWS.Forecast.CreateDatasetImportJob",
);
