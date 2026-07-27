import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload AWS Elemental MediaLive delivers to EventBridge.
 * State-change events carry the channel's new `state`; alert events carry
 * an `alarm_state`/`alert_type` pair plus a human `message`. Fields not
 * shared by every event kind are optional (the schema grows over time).
 */
export interface MediaLiveChannelEventDetail {
  /** The ARN of the channel (or multiplex) the event is about. */
  channel_arn?: string;
  /** State-change events: the channel's new state (e.g. `RUNNING`). */
  state?: string;
  /** Alert events: `SET` when the alert is raised, `CLEARED` when it clears. */
  alarm_state?: string;
  /** Alert events: a stable id for the alert instance. */
  alarm_id?: string;
  /** Alert events: the kind of problem (e.g. `Video Not Detected`). */
  alert_type?: string;
  /** Alert events: the pipeline the alert applies to (e.g. `0`). */
  pipeline?: string;
  /** A human-readable description of the event. */
  message?: string;
  /** State-change events: how many pipelines are currently running. */
  pipelines_running_count?: number;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A MediaLive EventBridge event delivered to the handler. */
export type MediaLiveChannelEvent = EventRecord<MediaLiveChannelEventDetail>;

/** Which MediaLive notifications to subscribe to. */
export type MediaLiveChannelEventKind =
  | "state-change"
  | "alert"
  | "input-change"
  | "multiplex-state-change"
  | "multiplex-alert";

const DETAIL_TYPES: Record<MediaLiveChannelEventKind, string> = {
  "state-change": "MediaLive Channel State Change",
  alert: "MediaLive Channel Alert",
  "input-change": "MediaLive Channel Input Change",
  "multiplex-state-change": "MediaLive Multiplex State Change",
  "multiplex-alert": "MediaLive Multiplex Alert",
};

export interface ChannelEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "MediaLiveChannelEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to: channel state changes
   * (IDLE/STARTING/RUNNING/STOPPING transitions and create/update
   * progress), channel alerts (raised/cleared error conditions such as a
   * lost input), input changes (which attached input is active), and the
   * multiplex equivalents.
   * @default ["state-change"]
   */
  kinds?: readonly MediaLiveChannelEventKind[];
  /**
   * Restrict to events about specific channels (matched against the
   * event's top-level `resources`, which contains the channel's ARN).
   */
  channelArns?: readonly string[];
}

/**
 * Event source connecting AWS Elemental MediaLive notifications to the
 * hosting compute. MediaLive publishes channel state changes
 * (IDLE/STARTING/RUNNING/STOPPING transitions), channel alerts (a lost
 * input, a failed output — SET and CLEARED), active-input changes, and
 * their multiplex equivalents to the account's default EventBridge bus
 * (source `aws.medialive`); this subscribes the host Function to those
 * events so it can page an operator, trigger automated pipeline recovery,
 * or reconcile a broadcast schedule.
 *
 * MediaLive publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Channel Events
 * @example Page an Operator When a Channel Raises an Alert
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default MonitorFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.MediaLive.consumeChannelEvents(
 *       { kinds: ["alert", "state-change"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           event.detail.alarm_state === "SET"
 *             ? Effect.log(`channel alert: ${event.detail.message}`)
 *             : Effect.void,
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeChannelEvents = <StreamReq = never, Req = never>(
  props: ChannelEventSourceProps,
  process: (
    events: Stream.Stream<MediaLiveChannelEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "MediaLiveChannelEvents",
    {
      source: ["aws.medialive"],
      "detail-type": (props.kinds ?? (["state-change"] as const)).map(
        (kind) => DETAIL_TYPES[kind],
      ),
      ...(props.channelArns !== undefined
        ? { resources: [...props.channelArns] }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
