import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload AWS Elemental MediaConnect delivers to EventBridge.
 * Alert events carry an `error-code`/`errored` pair plus a human `message`;
 * health and status-change events carry the changed state. Fields not
 * shared by every event kind are optional (the schema grows over time).
 */
export interface MediaConnectFlowEventDetail {
  /** Alert events: the MediaConnect error code (e.g. `NoSource`). */
  "error-code"?: string;
  /** Alert events: `true` when the alert is raised, `false` when cleared. */
  errored?: boolean;
  /** Alert events: a human-readable description of the issue. */
  message?: string;
  /** Status-change events: the flow's new status (e.g. `ACTIVE`). */
  status?: string;
  /** Health events: the name of the health metric that changed. */
  name?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A MediaConnect EventBridge event delivered to the handler. */
export type MediaConnectFlowEvent = EventRecord<MediaConnectFlowEventDetail>;

/** Which MediaConnect notifications to subscribe to. */
export type MediaConnectFlowEventKind =
  | "alert"
  | "flow-status-change"
  | "flow-health"
  | "flow-maintenance"
  | "flow-content-quality"
  | "source-health"
  | "output-health"
  | "output-status-change";

const DETAIL_TYPES: Record<MediaConnectFlowEventKind, string> = {
  alert: "MediaConnect Alert",
  "flow-status-change": "MediaConnect Flow Status Change",
  "flow-health": "MediaConnect Flow Health",
  "flow-maintenance": "MediaConnect Flow Maintenance",
  "flow-content-quality": "MediaConnect Flow Content Quality",
  "source-health": "MediaConnect Source Health",
  "output-health": "MediaConnect Output Health",
  "output-status-change": "MediaConnect Output Status Change",
};

export interface FlowEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "MediaConnectFlowEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to: alerts (raised/cleared error
   * conditions such as a disconnected source), flow status changes
   * (STANDBY/ACTIVE transitions), flow/source/output health, scheduled
   * flow maintenance, and content-quality events.
   * @default ["alert"]
   */
  kinds?: readonly MediaConnectFlowEventKind[];
  /**
   * Restrict to events about specific flows (matched against the event's
   * top-level `resources`, which contains the flow's ARN).
   */
  flowArns?: readonly string[];
}

/**
 * Event source connecting AWS Elemental MediaConnect flow notifications to
 * the hosting compute. MediaConnect publishes alerts (a source
 * disconnecting, failover firing), flow status changes (STANDBY/ACTIVE
 * transitions), flow/source/output health, scheduled maintenance, and
 * content-quality events to the account's default EventBridge bus (source
 * `aws.mediaconnect`); this subscribes the host Function to those events
 * so it can page an operator or trigger automated failover handling.
 *
 * MediaConnect publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Flow Events
 * @example Page an Operator When a Flow Raises an Alert
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default MonitorFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.MediaConnect.consumeFlowEvents(
 *       { kinds: ["alert", "flow-status-change"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           event.detail.errored === true
 *             ? Effect.log(`flow alert: ${event.detail.message}`)
 *             : Effect.void,
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeFlowEvents = <StreamReq = never, Req = never>(
  props: FlowEventSourceProps,
  process: (
    events: Stream.Stream<MediaConnectFlowEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "MediaConnectFlowEvents",
    {
      source: ["aws.mediaconnect"],
      "detail-type": (props.kinds ?? (["alert"] as const)).map(
        (kind) => DETAIL_TYPES[kind],
      ),
      ...(props.flowArns !== undefined
        ? { resources: [...props.flowArns] }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
