import type * as personalizeevents from "@distilled.cloud/aws/personalize-events";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Dataset } from "./Dataset.ts";

/**
 * `PutActions` request with `datasetArn` injected from the bound dataset.
 */
export interface PutActionsRequest extends Omit<
  personalizeevents.PutActionsRequest,
  "datasetArn"
> {}

/**
 * Runtime binding for `personalize:PutActions`, scoped to one {@link Dataset} —
 * Adds or updates actions incrementally in the bound Actions
 * {@link Dataset} for the NEXT_BEST_ACTION recipe.
 * Provide the implementation with
 * `Effect.provide(AWS.Personalize.PutActionsHttp)`.
 *
 * @binding
 * @section Incremental Imports
 * @example Upsert an Action
 * ```typescript
 * // init
 * const putActions = yield* Personalize.PutActions(actionsDataset);
 *
 * yield* putActions({ actions: [{ actionId: "action-1" }] });
 * ```
 */
export interface PutActions extends Binding.Service<
  PutActions,
  "AWS.Personalize.PutActions",
  (
    dataset: Dataset,
  ) => Effect.Effect<
    (
      request: PutActionsRequest,
    ) => Effect.Effect<
      personalizeevents.PutActionsResponse,
      personalizeevents.PutActionsError
    >
  >
> {}
export const PutActions = Binding.Service<PutActions>(
  "AWS.Personalize.PutActions",
);
