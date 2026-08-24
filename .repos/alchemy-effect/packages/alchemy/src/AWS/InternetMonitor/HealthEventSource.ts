import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { Input } from "../../Input.ts";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Amazon CloudWatch Internet Monitor delivers to
 * EventBridge when a monitor creates or resolves a health event. Fields not
 * shared by every event are optional (the schema grows over time).
 */
export interface HealthEventDetail {
  /** The ARN of the health event. */
  eventArn?: string;
  /** The id of the health event. */
  eventId?: string;
  /** Human-readable summary of the health event. */
  summary?: string;
  /** When the health event started (ISO 8601). */
  startedAt?: string;
  /** When the health event ended, for resolved events (ISO 8601). */
  endedAt?: string;
  /**
   * The impact type: `AVAILABILITY`, `PERFORMANCE`, `LOCAL_AVAILABILITY`,
   * or `LOCAL_PERFORMANCE`.
   */
  impactType?: string;
  /** The health event status: `ACTIVE` or `RESOLVED`. */
  status?: string;
  /** Percentage of the application's total traffic that is impacted. */
  percentOfTotalTrafficImpacted?: number;
  /** The client city-networks impacted by the health event. */
  impactedLocations?: unknown[];
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An Internet Monitor health event delivered to the handler. */
export type HealthEventRecord = EventRecord<HealthEventDetail>;

export interface HealthEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "InternetMonitorHealthEvents"
   */
  id?: string;
  /**
   * Restrict to health events emitted by the given monitors (matched
   * against the event's `resources` — the monitor ARNs). Pass
   * `monitor.monitorArn`.
   * @default all monitors in the account
   */
  monitorArns?: readonly Input<string>[];
  /**
   * Restrict to health events of the given impact types (matched against
   * the event detail's `impactType`: `AVAILABILITY`, `PERFORMANCE`,
   * `LOCAL_AVAILABILITY`, `LOCAL_PERFORMANCE`).
   */
  impactTypes?: readonly string[];
  /**
   * Restrict to health events with the given statuses (matched against the
   * event detail's `status`: `ACTIVE`, `RESOLVED`).
   */
  statuses?: readonly string[];
}

/**
 * Event source connecting Amazon CloudWatch Internet Monitor health events
 * to the hosting compute. When a monitor detects an availability or
 * performance issue between your application and your users' city-networks,
 * Internet Monitor publishes a health event to the account's default
 * EventBridge bus (source `aws.internetmonitor`); this subscribes the host
 * Function to those events so it can page, reroute traffic, or annotate
 * incidents.
 *
 * Internet Monitor publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Health Events
 * @example Page on Availability Drops
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const monitor = yield* AWS.InternetMonitor.Monitor("AppMonitor", {
 *       resources: [vpcArn],
 *       maxCityNetworksToMonitor: 100,
 *     });
 *
 *     yield* AWS.InternetMonitor.consumeHealthEvents(
 *       { monitorArns: [monitor.monitorArn], impactTypes: ["AVAILABILITY"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.logError(
 *             `Internet Monitor health event: ${event.detail.summary}`,
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeHealthEvents = <StreamReq = never, Req = never>(
  props: HealthEventSourceProps,
  process: (
    events: Stream.Stream<HealthEventRecord, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) => {
  const detail = {
    ...(props.impactTypes !== undefined
      ? { impactType: [...props.impactTypes] }
      : {}),
    ...(props.statuses !== undefined ? { status: [...props.statuses] } : {}),
  };
  return consumeBusEvents(
    props.id ?? "InternetMonitorHealthEvents",
    {
      source: ["aws.internetmonitor"],
      "detail-type": ["Internet Monitor Health Event"],
      ...(props.monitorArns !== undefined
        ? { resources: [...props.monitorArns] }
        : {}),
      ...(Object.keys(detail).length > 0 ? { detail } : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
};
