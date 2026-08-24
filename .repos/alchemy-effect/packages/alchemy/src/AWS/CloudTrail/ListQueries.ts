import type * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EventDataStore } from "./EventDataStore.ts";

/**
 * Runtime binding for `cloudtrail:ListQueries`.
 *
 * Lists the CloudTrail Lake queries that ran against the bound
 * {@link EventDataStore} in the last seven days — the store is injected from
 * the binding. Provide the implementation with
 * `Effect.provide(AWS.CloudTrail.ListQueriesHttp)`.
 * @binding
 * @section Querying CloudTrail Lake
 * @example List Recent Queries
 * ```typescript
 * // init — bind the operation to the event data store
 * const listQueries = yield* AWS.CloudTrail.ListQueries(store);
 *
 * // runtime
 * const result = yield* listQueries({ MaxResults: 10 });
 * console.log(result.Queries?.map((q) => q.QueryId));
 * ```
 */
export interface ListQueries extends Binding.Service<
  ListQueries,
  "AWS.CloudTrail.ListQueries",
  (
    store: EventDataStore,
  ) => Effect.Effect<
    (
      request?: Omit<cloudtrail.ListQueriesRequest, "EventDataStore">,
    ) => Effect.Effect<
      cloudtrail.ListQueriesResponse,
      cloudtrail.ListQueriesError
    >
  >
> {}
export const ListQueries = Binding.Service<ListQueries>(
  "AWS.CloudTrail.ListQueries",
);
