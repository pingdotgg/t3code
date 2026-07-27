import type * as quicksight from "@distilled.cloud/aws/quicksight";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataSet } from "./DataSet.ts";

/**
 * Runtime binding for `quicksight:CreateIngestion`.
 *
 * Triggers a SPICE refresh (ingestion) of the bound {@link DataSet} — e.g.
 * after a pipeline lands new data. `AwsAccountId` and `DataSetId` are
 * injected from the binding; the caller supplies a unique `IngestionId`.
 * Poll the refresh with
 * {@link DescribeIngestion | AWS.QuickSight.DescribeIngestion}. Provide the
 * implementation with `Effect.provide(AWS.QuickSight.CreateIngestionHttp)`.
 * @binding
 * @section Refreshing SPICE Data
 * @example Trigger A Full Refresh
 * ```typescript
 * // init — bind the operation to the dataset
 * const createIngestion = yield* AWS.QuickSight.CreateIngestion(dataSet);
 *
 * // runtime
 * const { IngestionId, IngestionStatus } = yield* createIngestion({
 *   IngestionId: crypto.randomUUID(),
 *   IngestionType: "FULL_REFRESH",
 * });
 * ```
 */
export interface CreateIngestion extends Binding.Service<
  CreateIngestion,
  "AWS.QuickSight.CreateIngestion",
  (
    dataSet: DataSet,
  ) => Effect.Effect<
    (
      request: Omit<
        quicksight.CreateIngestionRequest,
        "AwsAccountId" | "DataSetId"
      >,
    ) => Effect.Effect<
      quicksight.CreateIngestionResponse,
      quicksight.CreateIngestionError
    >
  >
> {}
export const CreateIngestion = Binding.Service<CreateIngestion>(
  "AWS.QuickSight.CreateIngestion",
);
