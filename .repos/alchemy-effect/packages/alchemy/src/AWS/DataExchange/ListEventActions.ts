import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dataexchange:ListEventActions`.
 *
 * Enumerates the account's event actions (auto-export rules on entitled
 * data sets), optionally filtered to one event source data set.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.ListEventActionsHttp)`.
 * @binding
 * @section Event Actions
 * @example List Auto-Export Rules
 * ```typescript
 * const listEventActions = yield* AWS.DataExchange.ListEventActions();
 *
 * // runtime
 * const { EventActions } = yield* listEventActions();
 * ```
 */
export interface ListEventActions extends Binding.Service<
  ListEventActions,
  "AWS.DataExchange.ListEventActions",
  () => Effect.Effect<
    (
      request?: dataexchange.ListEventActionsRequest,
    ) => Effect.Effect<
      dataexchange.ListEventActionsResponse,
      dataexchange.ListEventActionsError
    >
  >
> {}
export const ListEventActions = Binding.Service<ListEventActions>(
  "AWS.DataExchange.ListEventActions",
);
