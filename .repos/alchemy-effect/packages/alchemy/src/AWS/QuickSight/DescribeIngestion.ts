import type * as quicksight from "@distilled.cloud/aws/quicksight";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataSet } from "./DataSet.ts";

/**
 * Runtime binding for `quicksight:DescribeIngestion`.
 *
 * Reads the status, row counts, and error info of a SPICE ingestion on the
 * bound {@link DataSet}. `AwsAccountId` and `DataSetId` are injected from
 * the binding. Provide the implementation with
 * `Effect.provide(AWS.QuickSight.DescribeIngestionHttp)`.
 * @binding
 * @section Refreshing SPICE Data
 * @example Poll An Ingestion Until It Settles
 * ```typescript
 * // init — bind the operation to the dataset
 * const describeIngestion = yield* AWS.QuickSight.DescribeIngestion(dataSet);
 *
 * // runtime
 * const { Ingestion } = yield* describeIngestion({
 *   IngestionId: ingestionId,
 * }).pipe(
 *   Effect.repeat({
 *     schedule: Schedule.spaced("5 seconds"),
 *     until: (r) =>
 *       r.Ingestion?.IngestionStatus === "COMPLETED" ||
 *       r.Ingestion?.IngestionStatus === "FAILED",
 *     times: 24,
 *   }),
 * );
 * ```
 */
export interface DescribeIngestion extends Binding.Service<
  DescribeIngestion,
  "AWS.QuickSight.DescribeIngestion",
  (
    dataSet: DataSet,
  ) => Effect.Effect<
    (
      request: Omit<
        quicksight.DescribeIngestionRequest,
        "AwsAccountId" | "DataSetId"
      >,
    ) => Effect.Effect<
      quicksight.DescribeIngestionResponse,
      quicksight.DescribeIngestionError
    >
  >
> {}
export const DescribeIngestion = Binding.Service<DescribeIngestion>(
  "AWS.QuickSight.DescribeIngestion",
);
