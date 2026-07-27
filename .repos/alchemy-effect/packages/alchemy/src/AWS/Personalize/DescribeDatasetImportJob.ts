import type * as personalize from "@distilled.cloud/aws/personalize";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `personalize:DescribeDatasetImportJob` — Polls a bulk dataset import job for completion — pairs with
 * {@link CreateDatasetImportJob} in the MLOps retraining loop.
 * Provide the implementation with
 * `Effect.provide(AWS.Personalize.DescribeDatasetImportJobHttp)`.
 *
 * @binding
 * @section Retraining Loop
 * @example Poll an Import Job
 * ```typescript
 * // init
 * const describeDatasetImportJob = yield* Personalize.DescribeDatasetImportJob();
 *
 * const { datasetImportJob } = yield* describeDatasetImportJob({
 *   datasetImportJobArn,
 * });
 * const done = datasetImportJob?.status === "ACTIVE";
 * ```
 */
export interface DescribeDatasetImportJob extends Binding.Service<
  DescribeDatasetImportJob,
  "AWS.Personalize.DescribeDatasetImportJob",
  () => Effect.Effect<
    (
      request: personalize.DescribeDatasetImportJobRequest,
    ) => Effect.Effect<
      personalize.DescribeDatasetImportJobResponse,
      personalize.DescribeDatasetImportJobError
    >
  >
> {}
export const DescribeDatasetImportJob =
  Binding.Service<DescribeDatasetImportJob>(
    "AWS.Personalize.DescribeDatasetImportJob",
  );
