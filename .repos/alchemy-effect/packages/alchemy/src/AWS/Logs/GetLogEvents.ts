import type * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LogGroup } from "./LogGroup.ts";

export interface GetLogEventsRequest extends Omit<
  Logs.GetLogEventsRequest,
  "logGroupName" | "logGroupIdentifier"
> {}

/**
 * Runtime binding for `logs:GetLogEvents`.
 *
 * Bind this operation to a `LogGroup` inside a function runtime to get a
 * callable that reads log events from a single stream of the group,
 * automatically injecting the log group name.
 * @binding
 * @section Reading Logs
 * @example Read a Stream from the Beginning
 * ```typescript
 * const getLogEvents = yield* AWS.Logs.GetLogEvents(logGroup);
 *
 * const response = yield* getLogEvents({
 *   logStreamName: "my-stream",
 *   startFromHead: true,
 * });
 * ```
 *
 * @example Wire into a Lambda Function
 * ```typescript
 * // Provide the GetLogEventsHttp layer on the Function's init Effect;
 * // combine with Layer.mergeAll when using several Logs bindings.
 * export default TailFunction.make(
 *   { main: import.meta.url, url: true },
 *   Effect.gen(function* () {
 *     const logGroup = yield* AWS.Logs.LogGroup("AppLogs", {});
 *     const getLogEvents = yield* AWS.Logs.GetLogEvents(logGroup);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { events } = yield* getLogEvents({
 *           logStreamName: "my-stream",
 *           startFromHead: true,
 *         });
 *         return HttpServerResponse.json({ events });
 *       }),
 *     };
 *   }).pipe(Effect.provide(AWS.Logs.GetLogEventsHttp)),
 * );
 * ```
 */
export interface GetLogEvents extends Binding.Service<
  GetLogEvents,
  "AWS.Logs.GetLogEvents",
  <G extends LogGroup>(
    logGroup: G,
  ) => Effect.Effect<
    (
      request: GetLogEventsRequest,
    ) => Effect.Effect<Logs.GetLogEventsResponse, Logs.GetLogEventsError>
  >
> {}
export const GetLogEvents = Binding.Service<GetLogEvents>(
  "AWS.Logs.GetLogEvents",
);
