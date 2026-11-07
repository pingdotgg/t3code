import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for `dataexchange:ListEventActions`.
 *
 * Enumerates the account's event actions (auto-export rules on entitled
 * data sets), optionally filtered to one event source data set.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.ListEventActionsHttp)`.
 * ### Event Actions
 * **Example:** List Auto-Export Rules
 * ```typescript
 * const listEventActions = yield* AWS.DataExchange.ListEventActions();
 *
 * // runtime
 * const { EventActions } = yield* listEventActions();
 * ```
 *
 * @binding
 */
export interface ListEventActions extends Binding.Service<
  ListEventActions,
  "AWS.DataExchange.ListEventActions",
  () => Effect.Effect<
    (
      request?: dataexchange.ListEventActionsRequest,
    ) => Effect.Effect<dataexchange.ListEventActionsResponse, dataexchange.ListEventActionsError>
  >
> {}
export const ListEventActions = Binding.Service<ListEventActions>(
  "AWS.DataExchange.ListEventActions",
);
