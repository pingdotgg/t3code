import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
} from "../EventBridge/EventSource.ts";
import type { AutoScalingGroup } from "./AutoScalingGroup.ts";

/**
 * EventBridge `detail-type`s EC2 Auto Scaling emits when a scaling activity
 * finishes launching or terminating an instance.
 */
export type InstanceEventType =
  | "EC2 Instance Launch Successful"
  | "EC2 Instance Launch Unsuccessful"
  | "EC2 Instance Terminate Successful"
  | "EC2 Instance Terminate Unsuccessful";

/**
 * The `detail` payload EC2 Auto Scaling delivers to EventBridge when a
 * scaling activity launches or terminates an instance.
 */
export interface InstanceEventDetail {
  /**
   * ID of the scaling activity that produced the event.
   */
  ActivityId: string;
  /**
   * Name of the Auto Scaling Group the instance belongs to.
   */
  AutoScalingGroupName: string;
  /**
   * ID of the launched/terminated EC2 instance.
   */
  EC2InstanceId: string;
  /**
   * Final status of the activity (e.g. `InProgress`, `Successful`, `Failed`).
   */
  StatusCode: string;
  /**
   * Human-readable status message for unsuccessful activities.
   */
  StatusMessage?: string;
  /**
   * What initiated the activity (e.g. a policy execution or capacity change).
   */
  Cause?: string;
  /**
   * ISO-8601 time the activity started.
   */
  StartTime?: string;
  /**
   * ISO-8601 time the activity ended.
   */
  EndTime?: string;
  /**
   * Additional context, e.g. `{ "Availability Zone": "...", "Subnet ID": "..." }`.
   */
  Details?: Record<string, string>;
  /**
   * Where the instance is coming from (e.g. `EC2` or `WarmPool`).
   */
  Origin?: string;
  /**
   * Where the instance is headed (e.g. `AutoScalingGroup` or `WarmPool`).
   */
  Destination?: string;
}

/** An instance launch/terminate EventBridge event delivered to the handler. */
export type InstanceEvent = EventRecord<InstanceEventDetail>;

export interface InstanceEventSourceProps {
  /**
   * Logical id prefix for the EventBridge rule. Defaults to the Auto Scaling
   * Group's logical id.
   */
  id?: string;
  /**
   * Which instance events to deliver.
   * @default all four launch/terminate success/failure events
   */
  events?: InstanceEventType[];
}

const allInstanceEvents: InstanceEventType[] = [
  "EC2 Instance Launch Successful",
  "EC2 Instance Launch Unsuccessful",
  "EC2 Instance Terminate Successful",
  "EC2 Instance Terminate Unsuccessful",
];

/**
 * Deliver EC2 Auto Scaling instance launch/terminate events to the host
 * Function via EventBridge. Unlike {@link consumeLifecycleActions} this does
 * not pause the instance transition — it observes completed scaling
 * activities, e.g. to deregister an instance from an external system after
 * termination or alert on launch failures.
 *
 * The EventBridge pattern matches every event of the chosen detail-types in
 * the account; inspect `event.detail.AutoScalingGroupName` in the handler if
 * multiple groups share the Function.
 *
 * @section Observing the Fleet
 * @example React to instance launches and terminations
 * ```typescript
 * yield* consumeInstanceEvents(
 *   group,
 *   {
 *     events: [
 *       "EC2 Instance Launch Successful",
 *       "EC2 Instance Terminate Successful",
 *     ],
 *   },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(
 *         `${event["detail-type"]}: ${event.detail.EC2InstanceId} in ${event.detail.AutoScalingGroupName}`,
 *       ),
 *     ),
 * );
 * ```
 *
 * @example Alert on launch failures
 * ```typescript
 * yield* consumeInstanceEvents(
 *   group,
 *   { events: ["EC2 Instance Launch Unsuccessful"] },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       notify(`Launch failed: ${event.detail.StatusMessage}`),
 *     ),
 * );
 * ```
 */
export const consumeInstanceEvents = <StreamReq = never, Req = never>(
  group: AutoScalingGroup,
  props: InstanceEventSourceProps,
  process: (
    events: Stream.Stream<InstanceEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  // The pattern uses only literal `source` + `detail-type` so it round-trips
  // through both the deploy-time rule and the runtime matcher (Output values
  // cannot appear in the pattern — they don't resolve inside the deployed
  // bundle).
  consumeBusEvents(
    `${props.id ?? group.LogicalId}-InstanceEvents`,
    {
      source: ["aws.autoscaling"],
      "detail-type": props.events ?? allInstanceEvents,
    },
    process,
  );
