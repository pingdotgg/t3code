import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Amazon IVS delivers to EventBridge. Stream
 * state-change events describe the transition (`event_name` of
 * `Stream Start`, `Stream End`, or `Session Created` plus the
 * `channel_name`/`stream_id`); limit-breach events carry the breached
 * `limit_name` and `limit_value`; recording state changes carry the
 * `recording_status` and S3 key prefix. Fields not shared by every event
 * kind are optional (the schema grows over time).
 */
export interface IvsStreamEventDetail {
  /**
   * Stream state-change events: `Stream Start`, `Stream End`, or
   * `Session Created`. Limit-breach events: the name of the breached
   * limit.
   */
  event_name?: string;
  /** The name of the channel the event is about. */
  channel_name?: string;
  /** Stream state-change events: the id of the stream session. */
  stream_id?: string;
  /** Limit-breach events: the name of the breached limit. */
  limit_name?: string;
  /** Limit-breach events: the value of the breached limit. */
  limit_value?: number;
  /** Recording state-change events: the recording session id. */
  recording_session_id?: string;
  /**
   * Recording state-change events: `Recording Start`, `Recording End`,
   * or `Recording Start Failure`.
   */
  recording_status?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An Amazon IVS EventBridge event delivered to the handler. */
export type IvsStreamEvent = EventRecord<IvsStreamEventDetail>;

/** Which Amazon IVS notifications to subscribe to. */
export type IvsStreamEventKind =
  | "stream-state-change"
  | "recording-state-change"
  | "limit-breach";

const DETAIL_TYPES: Record<IvsStreamEventKind, string> = {
  "stream-state-change": "IVS Stream State Change",
  "recording-state-change": "IVS Recording State Change",
  "limit-breach": "IVS Limit Breach",
};

export interface StreamEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "IVSStreamEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to: stream state changes (stream
   * start/end, session created), recording state changes (recording
   * start/end/failure), and/or limit breaches.
   * @default ["stream-state-change"]
   */
  kinds?: readonly IvsStreamEventKind[];
  /**
   * Restrict to events about specific channels (matched against the
   * event's top-level `resources`, which contains the channel's ARN).
   */
  channelArns?: readonly string[];
}

/**
 * Event source connecting Amazon IVS stream notifications to the hosting
 * compute. IVS publishes stream state changes (a broadcast starting or
 * ending), recording state changes (an S3 recording starting, completing,
 * or failing), and account limit breaches to the account's default
 * EventBridge bus (source `aws.ivs`); this subscribes the host Function
 * to those events so it can react to broadcasts going live or recordings
 * landing in S3.
 *
 * IVS publishes to EventBridge automatically — no additional resource is
 * created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on
 * the Function effect.
 *
 * @section Consuming Stream Events
 * @example React When a Broadcast Starts
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default NotifyFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.IVS.consumeStreamEvents(
 *       { kinds: ["stream-state-change"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           event.detail.event_name === "Stream Start"
 *             ? Effect.log(`${event.detail.channel_name} went live`)
 *             : Effect.void,
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeStreamEvents = <StreamReq = never, Req = never>(
  props: StreamEventSourceProps,
  process: (
    events: Stream.Stream<IvsStreamEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "IVSStreamEvents",
    {
      source: ["aws.ivs"],
      "detail-type": (props.kinds ?? (["stream-state-change"] as const)).map(
        (kind) => DETAIL_TYPES[kind],
      ),
      ...(props.channelArns !== undefined
        ? { resources: [...props.channelArns] }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
