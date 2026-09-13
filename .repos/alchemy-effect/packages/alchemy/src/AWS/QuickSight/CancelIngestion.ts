import type * as quicksight from "@distilled.cloud/aws/quicksight";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataSet } from "./DataSet.ts";

/**
 * Runtime binding for `quicksight:CancelIngestion`.
 *
 * Cancels an in-flight SPICE ingestion on the bound {@link DataSet}.
 * `AwsAccountId` and `DataSetId` are injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.QuickSight.CancelIngestionHttp)`.
 * ### Refreshing SPICE Data
 * **Example:** Cancel A Running Refresh
 * ```typescript
 * // init — bind the operation to the dataset
 * const cancelIngestion = yield* AWS.QuickSight.CancelIngestion(dataSet);
 *
 * // runtime
 * yield* cancelIngestion({ IngestionId: ingestionId });
 * ```
 *
 * @binding
 */
export interface CancelIngestion extends Binding.Service<
  CancelIngestion,
  "AWS.QuickSight.CancelIngestion",
  (
    dataSet: DataSet,
  ) => Effect.Effect<
    (
      request: Omit<
        quicksight.CancelIngestionRequest,
        "AwsAccountId" | "DataSetId"
      >,
    ) => Effect.Effect<
      quicksight.CancelIngestionResponse,
      quicksight.CancelIngestionError
    >
  >
> {}
export const CancelIngestion = Binding.Service<CancelIngestion>(
  "AWS.QuickSight.CancelIngestion",
);
