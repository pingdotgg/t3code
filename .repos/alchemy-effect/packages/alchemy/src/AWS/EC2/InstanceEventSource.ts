import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
} from "../EventBridge/EventSource.ts";
import type { Instance } from "./Instance.ts";

/**
 * Lifecycle states EC2 reports through the
 * `EC2 Instance State-change Notification` EventBridge event.
 */
export type InstanceState =
  | "pending"
  | "running"
  | "shutting-down"
  | "stopping"
  | "stopped"
  | "terminated";

/**
 * The `detail` payload EC2 delivers to EventBridge when an instance changes
 * state.
 */
export interface InstanceStateChangeDetail {
  /**
   * ID of the instance that changed state.
   */
  "instance-id": string;
  /**
   * The state the instance transitioned into.
   */
  state: InstanceState;
}

/** An instance state-change EventBridge event delivered to the handler. */
export type InstanceStateChangeEvent = EventRecord<InstanceStateChangeDetail>;

export interface InstanceStateEventSourceProps {
  /**
   * Logical id prefix for the EventBridge rule. Defaults to the instance's
   * logical id.
   */
  id?: string;
  /**
   * Which instance states to deliver.
   * @default all six lifecycle states
   */
  states?: InstanceState[];
}

/**
 * Deliver EC2 instance state-change events to the host Function via
 * EventBridge — e.g. to deregister a host from an external system when it
 * stops, or alert when a critical box is terminated.
 *
 * The EventBridge pattern matches every instance state-change in the account
 * (narrowed to `states` when given); inspect `event.detail["instance-id"]` in
 * the handler if the Function should only react to specific instances — the
 * bound instance's id is an Output and cannot appear in the deploy-time rule
 * pattern.
 *
 * @section Observing Instance State
 * @example React to an instance stopping or terminating
 * ```typescript
 * yield* consumeInstanceStateEvents(
 *   instance,
 *   { states: ["stopped", "terminated"] },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(
 *         `${event.detail["instance-id"]} is now ${event.detail.state}`,
 *       ),
 *     ),
 * );
 * ```
 */
export const consumeInstanceStateEvents = <StreamReq = never, Req = never>(
  instance: Instance,
  props: InstanceStateEventSourceProps,
  process: (
    events: Stream.Stream<InstanceStateChangeEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  // The pattern uses only literal strings so it round-trips through both the
  // deploy-time rule and the runtime matcher (Output values cannot appear in
  // the pattern — they don't resolve inside the deployed bundle).
  consumeBusEvents(
    `${props.id ?? instance.LogicalId}-InstanceState`,
    {
      source: ["aws.ec2"],
      "detail-type": ["EC2 Instance State-change Notification"],
      ...(props.states ? { detail: { state: props.states } } : {}),
    },
    process,
  );
