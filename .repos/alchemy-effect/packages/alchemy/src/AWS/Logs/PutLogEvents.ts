import type * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LogGroup } from "./LogGroup.ts";

export type InputLogEvent = Logs.InputLogEvent;

export interface PutLogEventsRequest extends Omit<
  Logs.PutLogEventsRequest,
  "logGroupName" | "sequenceToken"
> {}

/**
 * Runtime binding for `logs:PutLogEvents`.
 *
 * Bind this operation to a `LogGroup` inside a function runtime to get a
 * callable that writes log events to a stream of the group (e.g. custom audit
 * trails), automatically injecting the log group name. The target log stream
 * must already exist (declare an `AWS.Logs.LogStream`). Sequence tokens are no
 * longer required by CloudWatch Logs.
 * @binding
 * @section Writing Logs
 * @example Write an Audit Event
 * ```typescript
 * const putLogEvents = yield* AWS.Logs.PutLogEvents(logGroup);
 *
 * yield* putLogEvents({
 *   logStreamName: stream.logStreamName,
 *   logEvents: [{ timestamp: now, message: "user.login id=123" }],
 * });
 * ```
 *
 * @example Wire into a Lambda Function
 * ```typescript
 * // Bind in the init phase, call in the handler, and provide the
 * // PutLogEventsHttp layer on the Function's init Effect.
 * export default AuditFunction.make(
 *   { main: import.meta.url, url: true },
 *   Effect.gen(function* () {
 *     const logGroup = yield* AWS.Logs.LogGroup("AuditLogs", {
 *       retention: "30 days",
 *     });
 *     const stream = yield* AWS.Logs.LogStream("AuditStream", {
 *       logGroupName: logGroup.logGroupName,
 *     });
 *     const putLogEvents = yield* AWS.Logs.PutLogEvents(logGroup);
 *     const LogStreamName = yield* stream.logStreamName;
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const timestamp = yield* Clock.currentTimeMillis;
 *         yield* putLogEvents({
 *           logStreamName: yield* LogStreamName,
 *           logEvents: [{ timestamp, message: "audit.event" }],
 *         });
 *         return HttpServerResponse.text("ok");
 *       }),
 *     };
 *   }).pipe(Effect.provide(AWS.Logs.PutLogEventsHttp)),
 * );
 * ```
 */
export interface PutLogEvents extends Binding.Service<
  PutLogEvents,
  "AWS.Logs.PutLogEvents",
  <G extends LogGroup>(
    logGroup: G,
  ) => Effect.Effect<
    (
      request: PutLogEventsRequest,
    ) => Effect.Effect<Logs.PutLogEventsResponse, Logs.PutLogEventsError>
  >
> {}
export const PutLogEvents = Binding.Service<PutLogEvents>(
  "AWS.Logs.PutLogEvents",
);
