import type * as ce from "@distilled.cloud/aws/cost-explorer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListCostAllocationTagBackfillHistory}.
 */
export interface ListCostAllocationTagBackfillHistoryRequest
  extends ce.ListCostAllocationTagBackfillHistoryRequest {}

/**
 * Runtime binding for `ce:ListCostAllocationTagBackfillHistory`.
 *
 * List your historical cost allocation tag backfill requests and
 * their status. Provide the implementation with
 * `Effect.provide(AWS.CostExplorer.ListCostAllocationTagBackfillHistoryHttp)`.
 * @binding
 * @section Cost Allocation Tags
 * @example List Backfill Requests
 * ```typescript
 * // init — account-level binding takes no resource
 * const listCostAllocationTagBackfillHistory = yield* AWS.CostExplorer.ListCostAllocationTagBackfillHistory();
 *
 * // runtime
 * const result = yield* listCostAllocationTagBackfillHistory();
 * const requests = result.BackfillRequests;
 * ```
 */
export interface ListCostAllocationTagBackfillHistory extends Binding.Service<
  ListCostAllocationTagBackfillHistory,
  "AWS.CostExplorer.ListCostAllocationTagBackfillHistory",
  () => Effect.Effect<
    (
      request?: ListCostAllocationTagBackfillHistoryRequest,
    ) => Effect.Effect<
      ce.ListCostAllocationTagBackfillHistoryResponse,
      ce.ListCostAllocationTagBackfillHistoryError
    >
  >
> {}

export const ListCostAllocationTagBackfillHistory =
  Binding.Service<ListCostAllocationTagBackfillHistory>(
    "AWS.CostExplorer.ListCostAllocationTagBackfillHistory",
  );
