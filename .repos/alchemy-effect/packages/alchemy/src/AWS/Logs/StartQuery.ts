import type * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LogGroup } from "./LogGroup.ts";

export interface StartQueryRequest extends Omit<
  Logs.StartQueryRequest,
  "logGroupName" | "logGroupNames" | "logGroupIdentifiers"
> {}

/**
 * Runtime binding for `logs:StartQuery` (CloudWatch Logs Insights).
 *
 * Bind this operation to a `LogGroup` inside a function runtime to get a
 * callable that starts an Insights query scoped to the group, automatically
 * injecting the log group name. Pair with
 * {@link import("./GetQueryResults.ts").GetQueryResults} to poll for results.
 * @binding
 * @section Logs Insights
 * @example Start an Insights Query
 * ```typescript
 * const startQuery = yield* AWS.Logs.StartQuery(logGroup);
 *
 * const { queryId } = yield* startQuery({
 *   queryString: "fields @timestamp, @message | limit 10",
 *   startTime: startEpochSeconds,
 *   endTime: endEpochSeconds,
 * });
 * ```
 *
 * @example Wire into a Lambda Function
 * ```typescript
 * // Insights queries are asynchronous: start one, then poll with the
 * // GetQueryResults binding. Provide both HTTP layers with Layer.mergeAll.
 * export default InsightsFunction.make(
 *   { main: import.meta.url, url: true },
 *   Effect.gen(function* () {
 *     const logGroup = yield* AWS.Logs.LogGroup("AppLogs", {});
 *     const startQuery = yield* AWS.Logs.StartQuery(logGroup);
 *     const getQueryResults = yield* AWS.Logs.GetQueryResults(logGroup);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const now = yield* Clock.currentTimeMillis;
 *         const { queryId } = yield* startQuery({
 *           queryString: "fields @timestamp, @message | limit 10",
 *           startTime: Math.floor(now / 1000) - 3600,
 *           endTime: Math.floor(now / 1000),
 *         });
 *         return HttpServerResponse.json({ queryId });
 *       }),
 *     };
 *   }).pipe(
 *     Effect.provide(
 *       Layer.mergeAll(AWS.Logs.StartQueryHttp, AWS.Logs.GetQueryResultsHttp),
 *     ),
 *   ),
 * );
 * ```
 */
export interface StartQuery extends Binding.Service<
  StartQuery,
  "AWS.Logs.StartQuery",
  <G extends LogGroup>(
    logGroup: G,
  ) => Effect.Effect<
    (
      request: StartQueryRequest,
    ) => Effect.Effect<Logs.StartQueryResponse, Logs.StartQueryError>
  >
> {}
export const StartQuery = Binding.Service<StartQuery>("AWS.Logs.StartQuery");
