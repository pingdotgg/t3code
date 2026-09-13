import type * as forecast from "@distilled.cloud/aws/forecast";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `forecast:DescribeDatasetImportJob` — poll an import
 * job started by {@link CreateDatasetImportJob} until its `Status` reaches
 * `ACTIVE` (or `CREATE_FAILED`), and read its field statistics.
 *
 * Import-job ARNs are created at runtime, so the binding takes no arguments
 * and grants `forecast:DescribeDatasetImportJob` on `*`. Provide the
 * implementation with
 * `Effect.provide(AWS.Forecast.DescribeDatasetImportJobHttp)`.
 *
 * ### Importing Data
 * **Example:** Poll an Import Job
 * ```typescript
 * // init
 * const describeDatasetImportJob = yield* AWS.Forecast.DescribeDatasetImportJob();
 *
 * // runtime
 * const detail = yield* describeDatasetImportJob({
 *   DatasetImportJobArn: job.DatasetImportJobArn!,
 * });
 * if (detail.Status === "CREATE_FAILED") {
 *   yield* Effect.logError(`import failed: ${detail.Message}`);
 * }
 * ```
 *
 * @binding
 */
export interface DescribeDatasetImportJob extends Binding.Service<
  DescribeDatasetImportJob,
  "AWS.Forecast.DescribeDatasetImportJob",
  () => Effect.Effect<
    (
      request: forecast.DescribeDatasetImportJobRequest,
    ) => Effect.Effect<
      forecast.DescribeDatasetImportJobResponse,
      forecast.DescribeDatasetImportJobError
    >
  >
> {}
export const DescribeDatasetImportJob =
  Binding.Service<DescribeDatasetImportJob>(
    "AWS.Forecast.DescribeDatasetImportJob",
  );
