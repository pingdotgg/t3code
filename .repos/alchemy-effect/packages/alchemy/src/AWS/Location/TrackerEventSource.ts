import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Amazon Location Service delivers to EventBridge.
 * Geofence events describe an ENTER/EXIT transition; device position events
 * describe an accepted position update on a tracker with EventBridge
 * publishing enabled. Fields not shared by every event kind are optional
 * (the schema grows over time).
 */
export interface TrackerEventDetail {
  /**
   * Geofence events: `ENTER` or `EXIT`. Device position events: `UPDATE`.
   */
  EventType?: string;
  /** The device the event is about. */
  DeviceId?: string;
  /** Geofence events: the geofence that was entered or exited. */
  GeofenceId?: string;
  /** The position sample that triggered the event ([longitude, latitude]). */
  Position?: number[];
  /** When the device reported the position. */
  SampleTime?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An Amazon Location EventBridge event delivered to the handler. */
export type TrackerEvent = EventRecord<TrackerEventDetail>;

/** Which Amazon Location notifications to subscribe to. */
export type TrackerEventKind = "geofence-event" | "device-position-event";

const DETAIL_TYPES: Record<TrackerEventKind, string> = {
  "geofence-event": "Location Geofence Event",
  "device-position-event": "Location Device Position Event",
};

export interface TrackerEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "LocationTrackerEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to: geofence ENTER/EXIT events
   * (emitted when a linked tracker's positions breach a geofence) and/or
   * raw device position updates (emitted by trackers with
   * `eventBridgeEnabled: true`).
   * @default ["geofence-event"]
   */
  kinds?: readonly TrackerEventKind[];
  /**
   * Restrict to events about specific resources (matched against the
   * event's top-level `resources`, which includes the tracker and geofence
   * collection ARNs).
   */
  resourceArns?: readonly string[];
}

/**
 * Event source connecting Amazon Location Service tracking notifications to
 * the hosting compute. Location publishes geofence ENTER/EXIT events (for
 * trackers linked to a geofence collection via {@link TrackerConsumer}) and
 * raw device position updates (for trackers with `eventBridgeEnabled: true`)
 * to the account's default EventBridge bus (source `aws.geo`); this
 * subscribes the host Function to those events.
 *
 * Location publishes to EventBridge automatically — no additional resource
 * is created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Tracker Events
 * @example React to Geofence Breaches
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.Location.consumeTrackerEvents(
 *       { kinds: ["geofence-event"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(
 *             `${event.detail.DeviceId} ${event.detail.EventType} ${event.detail.GeofenceId}`,
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeTrackerEvents = <StreamReq = never, Req = never>(
  props: TrackerEventSourceProps,
  process: (
    events: Stream.Stream<TrackerEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "LocationTrackerEvents",
    {
      source: ["aws.geo"],
      "detail-type": (props.kinds ?? (["geofence-event"] as const)).map(
        (kind) => DETAIL_TYPES[kind],
      ),
      ...(props.resourceArns !== undefined
        ? { resources: [...props.resourceArns] }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
