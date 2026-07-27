import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Amazon IVS Real-Time Streaming delivers to
 * EventBridge. Stage-update events describe participant activity
 * (`event_name` like `Participant Joined`, plus `participant_id` and
 * `session_id`); composition state changes describe the composition
 * lifecycle. Fields not shared by every event kind are optional (the schema
 * grows over time).
 */
export interface StageEventDetail {
  /**
   * What happened, e.g. `Participant Joined`, `Participant Left`,
   * `Participant Published`, or `Composition Started` / `Composition Ended`
   * for composition state changes.
   */
  event_name?: string;
  /** Stage-update events: the participant the event is about. */
  participant_id?: string;
  /** Stage-update events: the stage session the event occurred in. */
  session_id?: string;
  /** The user id attached to the participant's token, if any. */
  user_id?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An IVS Real-Time EventBridge event delivered to the handler. */
export type StageEvent = EventRecord<StageEventDetail>;

/** Which IVS Real-Time notifications to subscribe to. */
export type StageEventKind = "stage-update" | "composition-state-change";

const DETAIL_TYPES: Record<StageEventKind, string> = {
  "stage-update": "IVS Stage Update",
  "composition-state-change": "IVS Composition State Change",
};

export interface StageEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "IVSRealtimeStageEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to: stage updates (participants
   * joining/leaving/publishing, recording state changes) and/or composition
   * state changes (compositions starting, ending, failing).
   * @default ["stage-update"]
   */
  kinds?: readonly StageEventKind[];
  /**
   * Restrict to events about specific stages (matched against the event's
   * top-level `resources`, which carries the stage's ARN — or the
   * composition's ARN for composition state changes).
   */
  stageArns?: readonly string[];
}

/**
 * Event source connecting Amazon IVS Real-Time Streaming notifications to
 * the hosting compute. IVS publishes stage updates (participants joining,
 * leaving, publishing, recording state changes) and composition state
 * changes to the account's default EventBridge bus (source `aws.ivs`); this
 * subscribes the host Function to those events so it can track presence,
 * kick off post-session processing, or alert on failed compositions.
 *
 * IVS publishes to EventBridge automatically — no additional resource is
 * created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Stage Events
 * @example React to participants joining
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default PresenceFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.IVSRealtime.consumeStageEvents(
 *       { kinds: ["stage-update"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           event.detail.event_name === "Participant Joined"
 *             ? Effect.log(`joined: ${event.detail.participant_id}`)
 *             : Effect.void,
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeStageEvents = <StreamReq = never, Req = never>(
  props: StageEventSourceProps,
  process: (
    events: Stream.Stream<StageEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "IVSRealtimeStageEvents",
    {
      source: ["aws.ivs"],
      "detail-type": (props.kinds ?? (["stage-update"] as const)).map(
        (kind) => DETAIL_TYPES[kind],
      ),
      ...(props.stageArns !== undefined
        ? { resources: [...props.stageArns] }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
