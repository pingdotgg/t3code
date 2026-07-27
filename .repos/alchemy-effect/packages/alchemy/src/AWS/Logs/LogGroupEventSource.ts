import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { LogGroup } from "./LogGroup.ts";

/**
 * Raw Lambda invocation payload produced by a CloudWatch Logs subscription
 * filter: the log events are gzipped, base64-encoded JSON under
 * `awslogs.data`.
 */
export interface CloudWatchLogsEvent {
  /** Envelope holding the gzipped, base64-encoded subscription payload. */
  awslogs: {
    /** Base64-encoded gzip of a {@link LogsSubscriptionPayload} JSON document. */
    data: string;
  };
}

/**
 * Decoded CloudWatch Logs subscription payload (after base64 + gunzip).
 */
export interface LogsSubscriptionPayload {
  /** `DATA_MESSAGE` carries log events; `CONTROL_MESSAGE` is a delivery check. */
  messageType: "DATA_MESSAGE" | "CONTROL_MESSAGE";
  /** AWS account id that owns the source log group. */
  owner: string;
  /** Name of the log group the events came from. */
  logGroup: string;
  /** Name of the log stream the events came from. */
  logStream: string;
  /** Names of the subscription filters that matched the events. */
  subscriptionFilters: string[];
  /** The batch of matched log events. */
  logEvents: {
    /** Unique identifier of the log event. */
    id: string;
    /** Event timestamp (epoch milliseconds). */
    timestamp: number;
    /** The raw log line. */
    message: string;
  }[];
}

/**
 * A single decoded log event delivered through a subscription filter,
 * flattened with its source metadata.
 */
export interface LogEventRecord {
  /** Unique identifier of the log event. */
  id: string;
  /** Event timestamp (epoch milliseconds). */
  timestamp: number;
  /** The raw log line. */
  message: string;
  /** Name of the log group the event came from. */
  logGroup: string;
  /** Name of the log stream the event came from. */
  logStream: string;
  /** AWS account id that owns the source log group. */
  owner: string;
  /** Names of the subscription filters that matched the event. */
  subscriptionFilters: string[];
}

export interface LogGroupEventSourceProps {
  /**
   * Name for the backing subscription filter. If omitted, a deterministic
   * name is generated from the logical ids.
   */
  filterName?: string;
  /**
   * Filter pattern selecting which log events are delivered.
   * An empty string matches every log event.
   * @default ""
   */
  filterPattern?: string;
}

type LogEventsHandler<Req> = (
  events: Stream.Stream<LogEventRecord>,
) => Effect.Effect<void, never, Req>;

/**
 * Subscribe an Effect handler to log events produced by a CloudWatch Logs
 * {@link LogGroup}.
 *
 * At deploy time this creates the backing subscription filter targeting the
 * host Lambda function plus the `lambda:InvokeFunction` permission for
 * `logs.amazonaws.com`. At runtime the gzipped subscription payload is decoded
 * and each log event is delivered to the handler as a {@link LogEventRecord}.
 *
 * :::warning
 * Never subscribe a function to its own log group — every line the handler
 * logs would re-invoke the handler in an infinite loop.
 * :::
 *
 * @param logGroup The log group to consume log events from.
 * @param props Optional subscription filter configuration.
 * @param process The handler invoked with a stream of decoded log events
 * (last argument).
 * @binding
 * @section Consuming Log Events
 * @example Forward Error Logs
 * ```typescript
 * yield* AWS.Logs.consumeLogEvents(
 *   logGroup,
 *   { filterPattern: "?ERROR ?Error" },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(`${event.logStream}: ${event.message}`),
 *     ),
 * );
 * ```
 *
 * @example Wire the Event Source into a Lambda Function
 * ```typescript
 * // The Lambda implementation layer (AWS.Lambda.LogGroupEventSource)
 * // satisfies the LogGroupEventSource requirement of consumeLogEvents.
 * export default AlertsFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const source = yield* AWS.Logs.LogGroup("AppLogs", {
 *       retention: "7 days",
 *     });
 *     yield* AWS.Logs.consumeLogEvents(source, (events) =>
 *       Stream.runForEach(events, (event) => Effect.log(event.message)),
 *     );
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("ok")),
 *     };
 *   }).pipe(Effect.provide(AWS.Lambda.LogGroupEventSource)),
 * );
 * ```
 */
export function consumeLogEvents<G extends LogGroup, Req = never>(
  logGroup: G,
  process: LogEventsHandler<Req>,
): Effect.Effect<void, never, LogGroupEventSource>;
export function consumeLogEvents<G extends LogGroup, Req = never>(
  logGroup: G,
  props: LogGroupEventSourceProps,
  process: LogEventsHandler<Req>,
): Effect.Effect<void, never, LogGroupEventSource>;
export function consumeLogEvents<G extends LogGroup, Req = never>(
  logGroup: G,
  propsOrProcess: LogGroupEventSourceProps | LogEventsHandler<Req>,
  maybeProcess?: LogEventsHandler<Req>,
): Effect.Effect<void, never, LogGroupEventSource> {
  const [props, process] =
    typeof propsOrProcess === "function"
      ? [{} as LogGroupEventSourceProps, propsOrProcess]
      : [propsOrProcess, maybeProcess!];
  return LogGroupEventSource.use((source) => source(logGroup, props, process));
}

export class LogGroupEventSource extends Context.Service<
  LogGroupEventSource,
  LogGroupEventSourceService
>()("AWS.Logs.LogGroupEventSource") {}

export type LogGroupEventSourceService = <Req = never>(
  logGroup: LogGroup,
  props: LogGroupEventSourceProps,
  process: (
    events: Stream.Stream<LogEventRecord>,
  ) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;
