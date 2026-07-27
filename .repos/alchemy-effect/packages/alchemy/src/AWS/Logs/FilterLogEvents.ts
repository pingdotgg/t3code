import type * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LogGroup } from "./LogGroup.ts";

export interface FilterLogEventsRequest extends Omit<
  Logs.FilterLogEventsRequest,
  "logGroupName" | "logGroupIdentifier"
> {}

/**
 * Runtime binding for `logs:FilterLogEvents`.
 *
 * Bind this operation to a `LogGroup` inside a function runtime to get a
 * callable that searches log events across all streams of the group,
 * automatically injecting the log group name.
 * @binding
 * @section Reading Logs
 * @example Search for a Marker
 * ```typescript
 * const filterLogEvents = yield* AWS.Logs.FilterLogEvents(logGroup);
 *
 * const response = yield* filterLogEvents({
 *   filterPattern: '"ERROR"',
 *   limit: 100,
 * });
 * ```
 *
 * @example Wire into a Lambda Function
 * ```typescript
 * // Provide the FilterLogEventsHttp layer on the Function's init Effect.
 * export default SearchFunction.make(
 *   { main: import.meta.url, url: true },
 *   Effect.gen(function* () {
 *     const logGroup = yield* AWS.Logs.LogGroup("AppLogs", {});
 *     const filterLogEvents = yield* AWS.Logs.FilterLogEvents(logGroup);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const response = yield* filterLogEvents({ filterPattern: '"ERROR"' });
 *         return HttpServerResponse.json({ events: response.events });
 *       }),
 *     };
 *   }).pipe(Effect.provide(AWS.Logs.FilterLogEventsHttp)),
 * );
 * ```
 */
export interface FilterLogEvents extends Binding.Service<
  FilterLogEvents,
  "AWS.Logs.FilterLogEvents",
  <G extends LogGroup>(
    logGroup: G,
  ) => Effect.Effect<
    (
      request?: FilterLogEventsRequest,
    ) => Effect.Effect<Logs.FilterLogEventsResponse, Logs.FilterLogEventsError>
  >
> {}
export const FilterLogEvents = Binding.Service<FilterLogEvents>(
  "AWS.Logs.FilterLogEvents",
);
