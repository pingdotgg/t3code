import type * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EventDataStore } from "./EventDataStore.ts";

/**
 * Request for the {@link StartQuery} binding. CloudTrail Lake SQL references
 * the event data store by its ID (the ARN's `eventdatastore/` suffix) in the
 * `FROM` clause, so `QueryStatement` may be a function that receives the
 * bound store's ID and returns the SQL text.
 */
export interface StartQueryRequest extends Omit<
  cloudtrail.StartQueryRequest,
  "QueryStatement"
> {
  /**
   * The SQL statement, or a function producing it from the bound event data
   * store's ID (for the `FROM <eventDataStoreId>` clause).
   */
  QueryStatement: string | ((eventDataStoreId: string) => string);
}

/**
 * Runtime binding for `cloudtrail:StartQuery`.
 *
 * Starts a CloudTrail Lake SQL query against the bound
 * {@link EventDataStore} and returns the `QueryId` to poll with
 * {@link DescribeQuery} / {@link GetQueryResults}. Provide the implementation
 * with `Effect.provide(AWS.CloudTrail.StartQueryHttp)`.
 * @binding
 * @section Querying CloudTrail Lake
 * @example Start a Lake Query
 * ```typescript
 * // init — bind the operation to the event data store
 * const startQuery = yield* AWS.CloudTrail.StartQuery(store);
 *
 * // runtime — the callback receives the store's ID for the FROM clause
 * const { QueryId } = yield* startQuery({
 *   QueryStatement: (id) =>
 *     `SELECT eventID, eventName FROM ${id} LIMIT 10`,
 * });
 * ```
 */
export interface StartQuery extends Binding.Service<
  StartQuery,
  "AWS.CloudTrail.StartQuery",
  (
    store: EventDataStore,
  ) => Effect.Effect<
    (
      request: StartQueryRequest,
    ) => Effect.Effect<
      cloudtrail.StartQueryResponse,
      cloudtrail.StartQueryError
    >
  >
> {}
export const StartQuery = Binding.Service<StartQuery>(
  "AWS.CloudTrail.StartQuery",
);
