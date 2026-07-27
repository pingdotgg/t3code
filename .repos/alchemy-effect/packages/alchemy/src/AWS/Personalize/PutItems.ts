import type * as personalizeevents from "@distilled.cloud/aws/personalize-events";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Dataset } from "./Dataset.ts";

/**
 * `PutItems` request with `datasetArn` injected from the bound dataset.
 */
export interface PutItemsRequest extends Omit<
  personalizeevents.PutItemsRequest,
  "datasetArn"
> {}

/**
 * Runtime binding for `personalize:PutItems`, scoped to one {@link Dataset} —
 * Adds or updates items incrementally in the bound Items {@link Dataset}
 * — the streaming alternative to a bulk dataset import job for keeping
 * the catalog fresh.
 * Provide the implementation with
 * `Effect.provide(AWS.Personalize.PutItemsHttp)`.
 *
 * @binding
 * @section Incremental Imports
 * @example Upsert an Item
 * ```typescript
 * // init
 * const putItems = yield* Personalize.PutItems(itemsDataset);
 *
 * yield* putItems({
 *   items: [{
 *     itemId: "item-42",
 *     properties: JSON.stringify({ category: "books" }),
 *   }],
 * });
 * ```
 */
export interface PutItems extends Binding.Service<
  PutItems,
  "AWS.Personalize.PutItems",
  (
    dataset: Dataset,
  ) => Effect.Effect<
    (
      request: PutItemsRequest,
    ) => Effect.Effect<
      personalizeevents.PutItemsResponse,
      personalizeevents.PutItemsError
    >
  >
> {}
export const PutItems = Binding.Service<PutItems>("AWS.Personalize.PutItems");
