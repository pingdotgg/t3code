import type * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EventDataStore } from "./EventDataStore.ts";

/**
 * Runtime binding for `cloudtrail:GetQueryResults`.
 *
 * Reads one page of a finished CloudTrail Lake query's result rows — use
 * `NextToken`/`MaxQueryResults` to paginate large results. Provide the
 * implementation with `Effect.provide(AWS.CloudTrail.GetQueryResultsHttp)`.
 * @binding
 * @section Querying CloudTrail Lake
 * @example Read Query Results
 * ```typescript
 * // init — bind the operation to the event data store
 * const getQueryResults = yield* AWS.CloudTrail.GetQueryResults(store);
 *
 * // runtime
 * const page = yield* getQueryResults({ QueryId: queryId });
 * console.log(page.QueryResultRows?.length);
 * ```
 */
export interface GetQueryResults extends Binding.Service<
  GetQueryResults,
  "AWS.CloudTrail.GetQueryResults",
  (
    store: EventDataStore,
  ) => Effect.Effect<
    (
      request: Omit<cloudtrail.GetQueryResultsRequest, "EventDataStore">,
    ) => Effect.Effect<
      cloudtrail.GetQueryResultsResponse,
      cloudtrail.GetQueryResultsError
    >
  >
> {}
export const GetQueryResults = Binding.Service<GetQueryResults>(
  "AWS.CloudTrail.GetQueryResults",
);
