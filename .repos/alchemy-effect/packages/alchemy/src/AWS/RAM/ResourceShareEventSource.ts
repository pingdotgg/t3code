import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `event` values RAM publishes inside the `Resource Sharing State
 * Change` detail — which sharing activity changed state.
 */
export type ResourceShareEventName =
  | "Resource Share Association"
  | "Resource Share Invitation"
  | (string & {});

/**
 * The `detail` payload AWS RAM delivers to EventBridge for
 * `Resource Sharing State Change` events. RAM emits these on a best-effort
 * basis for changes to resource shares — for both the share owner and the
 * principals granted access.
 */
export interface ResourceShareEventDetail {
  /** Which sharing activity changed state, e.g. `Resource Share Association`. */
  event?: ResourceShareEventName;
  /** The new status, e.g. `associated`, `disassociated`, or `failed`. */
  status?: string;
  /** Additional fields RAM includes (the schema grows over time). */
  [key: string]: unknown;
}

/** An AWS RAM EventBridge event delivered to the handler. */
export type ResourceShareEvent = EventRecord<ResourceShareEventDetail>;

export interface ResourceShareEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "ResourceShareEvents"
   */
  id?: string;
  /**
   * Which sharing activities to subscribe to (matched against
   * `detail.event`), e.g. `["Resource Share Association"]`.
   * @default all RAM events
   */
  events?: readonly ResourceShareEventName[];
  /**
   * Which statuses to subscribe to (matched against `detail.status`),
   * e.g. `["failed"]` to alert on sharing failures.
   * @default all statuses
   */
  statuses?: readonly string[];
}

/**
 * Event source connecting AWS RAM resource-sharing events to the hosting
 * compute. RAM publishes `Resource Sharing State Change` events (source
 * `aws.ram`) to the default EventBridge bus in near-real time — for both the
 * share owner and the principals granted access — whenever a resource share
 * changes state; this subscribes the host Function to those events so it can
 * drive invitation-acceptance or failure-alerting automation.
 *
 * RAM publishes to EventBridge automatically (best effort — events can be
 * dropped) — no additional resource is created besides the EventBridge rule
 * targeting the host. Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Resource Sharing Events
 * @example Alert on Resource Share Failures
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default SharingMonitor.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.RAM.consumeResourceShareEvents(
 *       { events: ["Resource Share Association"], statuses: ["failed"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(`sharing failed: ${JSON.stringify(event.detail)}`),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeResourceShareEvents = <StreamReq = never, Req = never>(
  props: ResourceShareEventSourceProps,
  process: (
    events: Stream.Stream<ResourceShareEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "ResourceShareEvents",
    {
      source: ["aws.ram"],
      "detail-type": ["Resource Sharing State Change"],
      ...(props.events !== undefined || props.statuses !== undefined
        ? {
            detail: {
              ...(props.events !== undefined
                ? { event: [...props.events] }
                : {}),
              ...(props.statuses !== undefined
                ? { status: [...props.statuses] }
                : {}),
            },
          }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
