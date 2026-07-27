import type * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EventDataStore } from "./EventDataStore.ts";

/**
 * Runtime binding for `cloudtrail:CancelQuery`.
 *
 * Cancels a running CloudTrail Lake query. Cancelling a query that already
 * finished fails with the typed `InactiveQueryException`. Provide the
 * implementation with `Effect.provide(AWS.CloudTrail.CancelQueryHttp)`.
 * @binding
 * @section Querying CloudTrail Lake
 * @example Cancel a Running Query
 * ```typescript
 * // init — bind the operation to the event data store
 * const cancelQuery = yield* AWS.CloudTrail.CancelQuery(store);
 *
 * // runtime
 * const result = yield* cancelQuery({ QueryId: queryId });
 * console.log(result.QueryStatus); // CANCELLED
 * ```
 */
export interface CancelQuery extends Binding.Service<
  CancelQuery,
  "AWS.CloudTrail.CancelQuery",
  (
    store: EventDataStore,
  ) => Effect.Effect<
    (
      request: Omit<cloudtrail.CancelQueryRequest, "EventDataStore">,
    ) => Effect.Effect<
      cloudtrail.CancelQueryResponse,
      cloudtrail.CancelQueryError
    >
  >
> {}
export const CancelQuery = Binding.Service<CancelQuery>(
  "AWS.CloudTrail.CancelQuery",
);
