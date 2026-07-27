import type * as quicksight from "@distilled.cloud/aws/quicksight";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataSet } from "./DataSet.ts";

/**
 * Runtime binding for `quicksight:ListIngestions`.
 *
 * Lists the SPICE ingestion history of the bound {@link DataSet} (most
 * recent first) — useful for skipping a refresh that is already running or
 * for surfacing the last refresh outcome. `AwsAccountId` and `DataSetId`
 * are injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.QuickSight.ListIngestionsHttp)`.
 * @binding
 * @section Refreshing SPICE Data
 * @example Read The Latest Refresh Outcome
 * ```typescript
 * // init — bind the operation to the dataset
 * const listIngestions = yield* AWS.QuickSight.ListIngestions(dataSet);
 *
 * // runtime
 * const { Ingestions } = yield* listIngestions({ MaxResults: 1 });
 * const latest = Ingestions?.[0];
 * ```
 */
export interface ListIngestions extends Binding.Service<
  ListIngestions,
  "AWS.QuickSight.ListIngestions",
  (
    dataSet: DataSet,
  ) => Effect.Effect<
    (
      request?: Omit<
        quicksight.ListIngestionsRequest,
        "AwsAccountId" | "DataSetId"
      >,
    ) => Effect.Effect<
      quicksight.ListIngestionsResponse,
      quicksight.ListIngestionsError
    >
  >
> {}
export const ListIngestions = Binding.Service<ListIngestions>(
  "AWS.QuickSight.ListIngestions",
);
