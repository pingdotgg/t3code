import type * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LogGroup } from "./LogGroup.ts";

export interface GetQueryResultsRequest extends Logs.GetQueryResultsRequest {}

/**
 * Runtime binding for `logs:GetQueryResults` (CloudWatch Logs Insights).
 *
 * Bind this operation to the `LogGroup` an Insights query was started against
 * (via {@link import("./StartQuery.ts").StartQuery}) to poll for its results.
 * @binding
 * @section Logs Insights
 * @example Poll Query Results
 * ```typescript
 * const getQueryResults = yield* AWS.Logs.GetQueryResults(logGroup);
 *
 * const response = yield* getQueryResults({ queryId });
 * if (response.status === "Complete") {
 *   // response.results is an array of field/value rows
 * }
 * ```
 *
 * @example Poll Until Complete
 * ```typescript
 * // Bounded, declarative polling — never a while-loop.
 * const results = yield* getQueryResults({ queryId }).pipe(
 *   Effect.repeat({
 *     schedule: Schedule.spaced("2 seconds"),
 *     until: (r) => r.status === "Complete",
 *     times: 15,
 *   }),
 * );
 * ```
 *
 * @example Wire into a Lambda Function
 * ```typescript
 * // Provide the layer on the Function's init Effect, merged with
 * // StartQueryHttp since the two bindings are always used together.
 * export default InsightsFunction.make(
 *   { main: import.meta.url, url: true },
 *   Effect.gen(function* () {
 *     const logGroup = yield* AWS.Logs.LogGroup("AppLogs", {});
 *     const startQuery = yield* AWS.Logs.StartQuery(logGroup);
 *     const getQueryResults = yield* AWS.Logs.GetQueryResults(logGroup);
 *     // ... start the query and poll for results in the fetch handler
 *     return { fetch: handler };
 *   }).pipe(
 *     Effect.provide(
 *       Layer.mergeAll(AWS.Logs.StartQueryHttp, AWS.Logs.GetQueryResultsHttp),
 *     ),
 *   ),
 * );
 * ```
 */
export interface GetQueryResults extends Binding.Service<
  GetQueryResults,
  "AWS.Logs.GetQueryResults",
  <G extends LogGroup>(
    logGroup: G,
  ) => Effect.Effect<
    (
      request: GetQueryResultsRequest,
    ) => Effect.Effect<Logs.GetQueryResultsResponse, Logs.GetQueryResultsError>
  >
> {}
export const GetQueryResults = Binding.Service<GetQueryResults>(
  "AWS.Logs.GetQueryResults",
);
