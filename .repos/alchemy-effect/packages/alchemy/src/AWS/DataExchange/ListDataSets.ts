import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dataexchange:ListDataSets`.
 *
 * Enumerates the account's data sets — `Origin: "OWNED"` for data sets
 * this account publishes, `Origin: "ENTITLED"` for active
 * subscriptions.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.ListDataSetsHttp)`.
 * @binding
 * @section Reading Data Sets
 * @example List Entitled Data Sets
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listDataSets = yield* AWS.DataExchange.ListDataSets();
 *
 * // runtime
 * const { DataSets } = yield* listDataSets({ Origin: "ENTITLED" });
 * ```
 */
export interface ListDataSets extends Binding.Service<
  ListDataSets,
  "AWS.DataExchange.ListDataSets",
  () => Effect.Effect<
    (
      request?: dataexchange.ListDataSetsRequest,
    ) => Effect.Effect<
      dataexchange.ListDataSetsResponse,
      dataexchange.ListDataSetsError
    >
  >
> {}
export const ListDataSets = Binding.Service<ListDataSets>(
  "AWS.DataExchange.ListDataSets",
);
