import type * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import type * as Effect from "effect/Effect";
import type * as Sink from "effect/Sink";
import * as Binding from "../../Binding.ts";
import type { BatchRetryExhaustedError } from "../internal/BatchedSink.ts";
import type { LogGroup } from "./LogGroup.ts";

export interface LogEventSinkProps {
  /**
   * Name of the target log stream. The stream must already exist — declare an
   * `AWS.Logs.LogStream` alongside the log group.
   */
  readonly logStreamName: string;
}

export type LogEventSinkError =
  | Logs.PutLogEventsError
  | BatchRetryExhaustedError<Logs.InputLogEvent>;

/**
 * A batching sink over CloudWatch Logs `PutLogEvents` (10,000 events /
 * 1,048,576 bytes per call, where each event costs its UTF-8 message size
 * plus 26 bytes of overhead).
 *
 * Each input element is a raw `InputLogEvent`, so ordering stays with the
 * caller: `PutLogEvents` requires events in chronological order by
 * `timestamp`, and the time span within one batch must not exceed 24 hours.
 *
 * Events the API reports via `rejectedLogEventsInfo` (older than 14 days or
 * the group's retention period, expired, or more than 2 hours in the future)
 * are **permanently** rejected — they are dropped and surfaced with a
 * warning, never retried. The remaining valid events in the batch are still
 * ingested by the API.
 *
 * @binding
 * @section Streaming Log Events
 * @example Drain a Stream of Events into a Log Stream
 * ```typescript
 * const sink = yield* AWS.Logs.LogEventSink(logGroup, {
 *   logStreamName: "audit-stream",
 * });
 *
 * // Inside a handler: drain fully before returning.
 * yield* Stream.fromIterable(entries).pipe(
 *   Stream.map((entry) => ({ timestamp: entry.at, message: entry.text })),
 *   Stream.run(sink),
 * );
 * ```
 *
 * @example Wire into a Lambda Function
 * ```typescript
 * // LogEventSinkHttp batches over the PutLogEvents binding, so provide
 * // PutLogEventsHttp into it with Layer.provideMerge.
 * export default IngestFunction.make(
 *   { main: import.meta.url, url: true },
 *   Effect.gen(function* () {
 *     const logGroup = yield* AWS.Logs.LogGroup("IngestLogs", {});
 *     yield* AWS.Logs.LogStream("IngestStream", {
 *       logGroupName: logGroup.logGroupName,
 *       logStreamName: "ingest-stream",
 *     });
 *     const sink = yield* AWS.Logs.LogEventSink(logGroup, {
 *       logStreamName: "ingest-stream",
 *     });
 *     // ... run streams of InputLogEvents into `sink` in the fetch handler
 *     return { fetch: handler };
 *   }).pipe(
 *     Effect.provide(
 *       Layer.provideMerge(AWS.Logs.LogEventSinkHttp, AWS.Logs.PutLogEventsHttp),
 *     ),
 *   ),
 * );
 * ```
 */
export interface LogEventSink extends Binding.Service<
  LogEventSink,
  "AWS.Logs.LogEventSink",
  (
    logGroup: LogGroup,
    props: LogEventSinkProps,
  ) => Effect.Effect<
    Sink.Sink<
      void,
      Logs.InputLogEvent,
      readonly Logs.InputLogEvent[],
      LogEventSinkError
    >
  >
> {}

export const LogEventSink = Binding.Service<LogEventSink>(
  "AWS.Logs.LogEventSink",
);
