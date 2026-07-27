import type * as personalizeevents from "@distilled.cloud/aws/personalize-events";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Dataset } from "./Dataset.ts";

/**
 * `PutUsers` request with `datasetArn` injected from the bound dataset.
 */
export interface PutUsersRequest extends Omit<
  personalizeevents.PutUsersRequest,
  "datasetArn"
> {}

/**
 * Runtime binding for `personalize:PutUsers`, scoped to one {@link Dataset} —
 * Adds or updates users incrementally in the bound Users {@link Dataset}
 * — the streaming alternative to a bulk dataset import job for keeping
 * user metadata fresh.
 * Provide the implementation with
 * `Effect.provide(AWS.Personalize.PutUsersHttp)`.
 *
 * @binding
 * @section Incremental Imports
 * @example Upsert a User
 * ```typescript
 * // init
 * const putUsers = yield* Personalize.PutUsers(usersDataset);
 *
 * yield* putUsers({
 *   users: [{
 *     userId: "user-1",
 *     properties: JSON.stringify({ membership: "gold" }),
 *   }],
 * });
 * ```
 */
export interface PutUsers extends Binding.Service<
  PutUsers,
  "AWS.Personalize.PutUsers",
  (
    dataset: Dataset,
  ) => Effect.Effect<
    (
      request: PutUsersRequest,
    ) => Effect.Effect<
      personalizeevents.PutUsersResponse,
      personalizeevents.PutUsersError
    >
  >
> {}
export const PutUsers = Binding.Service<PutUsers>("AWS.Personalize.PutUsers");
