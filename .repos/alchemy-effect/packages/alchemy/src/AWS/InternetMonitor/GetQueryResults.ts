import * as im from "@distilled.cloud/aws/internetmonitor";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Monitor } from "./Monitor.ts";

export interface GetQueryResultsRequest extends Omit<
  im.GetQueryResultsInput,
  "MonitorName"
> {}

/**
 * Runtime binding for `internetmonitor:GetQueryResults` — fetch the result
 * rows of a `SUCCEEDED` query on the bound {@link Monitor}; the monitor name
 * is injected automatically.
 *
 * Provide `InternetMonitor.GetQueryResultsHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Querying Measurements
 * @example Read Query Results
 * ```typescript
 * // init — grants internetmonitor:GetQueryResults on the monitor
 * const getQueryResults = yield* AWS.InternetMonitor.GetQueryResults(monitor);
 *
 * // runtime
 * const { Fields, Data } = yield* getQueryResults({ QueryId: queryId });
 * ```
 */
export interface GetQueryResults extends Binding.Service<
  GetQueryResults,
  "AWS.InternetMonitor.GetQueryResults",
  (
    monitor: Monitor,
  ) => Effect.Effect<
    (
      request: GetQueryResultsRequest,
    ) => Effect.Effect<im.GetQueryResultsOutput, im.GetQueryResultsError>
  >
> {}

export const GetQueryResults = Binding.Service<GetQueryResults>(
  "AWS.InternetMonitor.GetQueryResults",
);
