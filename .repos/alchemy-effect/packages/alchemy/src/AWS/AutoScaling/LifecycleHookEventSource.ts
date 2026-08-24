import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
} from "../EventBridge/EventSource.ts";
import type { AutoScalingGroup } from "./AutoScalingGroup.ts";
import {
  LifecycleHook,
  normalizeTransition,
  type LifecycleActionResult,
  type LifecycleTransition,
} from "./LifecycleHook.ts";

/**
 * The `detail` payload EC2 Auto Scaling delivers to EventBridge when an instance
 * enters a lifecycle wait state.
 */
export interface LifecycleActionDetail {
  /**
   * Token identifying this specific lifecycle action; pass it to
   * `complete`/`heartbeat` on the {@link CompleteLifecycleAction} binding.
   */
  LifecycleActionToken: string;
  /**
   * Name of the Auto Scaling Group the instance belongs to.
   */
  AutoScalingGroupName: string;
  /**
   * Name of the lifecycle hook that paused the instance.
   */
  LifecycleHookName: string;
  /**
   * ID of the EC2 instance in the wait state.
   */
  EC2InstanceId: string;
  /**
   * The paused transition (e.g. `autoscaling:EC2_INSTANCE_LAUNCHING`).
   */
  LifecycleTransition: string;
  /**
   * Metadata configured on the hook via `notificationMetadata`.
   */
  NotificationMetadata?: string;
  /**
   * Where the instance is coming from (e.g. `EC2` or `WarmPool`).
   */
  Origin?: string;
  /**
   * Where the instance is headed (e.g. `AutoScalingGroup` or `WarmPool`).
   */
  Destination?: string;
}

/** A lifecycle-action EventBridge event delivered to the handler. */
export type LifecycleActionEvent = EventRecord<LifecycleActionDetail>;

export interface LifecycleHookEventSourceProps {
  /**
   * Logical id prefix for the backing hook + EventBridge rule. Defaults to the
   * Auto Scaling Group's logical id.
   */
  id?: string;
  /**
   * Physical name for the lifecycle hook. If omitted, a deterministic name is
   * generated.
   */
  lifecycleHookName?: string;
  /**
   * Instance state transition to pause on.
   */
  lifecycleTransition: LifecycleTransition;
  /**
   * Maximum time an instance stays paused before `defaultResult` applies,
   * e.g. `"5 minutes"` or `Duration.seconds(300)` (whole seconds on the
   * wire).
   * @default "1 hour"
   */
  heartbeatTimeout?: Duration.Input;
  /**
   * Action taken when the hook times out.
   * @default "ABANDON"
   */
  defaultResult?: LifecycleActionResult;
  /**
   * Metadata delivered with the lifecycle event.
   */
  notificationMetadata?: string;
}

const detailTypeFor = (transition: string): string =>
  transition === "autoscaling:EC2_INSTANCE_LAUNCHING"
    ? "EC2 Instance-launch Lifecycle Action"
    : "EC2 Instance-terminate Lifecycle Action";

/**
 * Pause an Auto Scaling instance transition and deliver the lifecycle event to
 * the host Function. Creates the backing {@link LifecycleHook} on `group` (so
 * instances actually pause) and subscribes the Function to the matching
 * `aws.autoscaling` EventBridge events. Pair with
 * {@link CompleteLifecycleAction} to signal `CONTINUE` / `ABANDON` from the
 * handler.
 *
 * The EventBridge pattern matches every lifecycle action of this transition in
 * the account; inspect `event.detail.AutoScalingGroupName` /
 * `event.detail.LifecycleHookName` in the handler if multiple groups share the
 * Function.
 *
 * @section Draining Instances
 * @example Signal CONTINUE when an instance is about to terminate
 * ```typescript
 * const lifecycle = yield* CompleteLifecycleAction(group);
 * yield* consumeLifecycleActions(
 *   group,
 *   { lifecycleTransition: "TERMINATING", heartbeatTimeout: "300 seconds" },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       lifecycle
 *         .complete({
 *           LifecycleHookName: event.detail.LifecycleHookName,
 *           LifecycleActionToken: event.detail.LifecycleActionToken,
 *           LifecycleActionResult: "CONTINUE",
 *         })
 *         .pipe(Effect.orDie),
 *     ),
 * );
 * ```
 *
 * @example Register the event source inside a Lambda Function
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 * import {
 *   CompleteLifecycleAction,
 *   CompleteLifecycleActionHttp,
 *   consumeLifecycleActions,
 * } from "alchemy/AWS/AutoScaling";
 *
 * export class DrainFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
 *   "DrainFunction",
 * ) {}
 *
 * export default DrainFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const lifecycle = yield* CompleteLifecycleAction(group);
 *
 *     // creates the LifecycleHook on the group and subscribes this Function
 *     // to the matching EventBridge lifecycle events
 *     yield* consumeLifecycleActions(
 *       group,
 *       { lifecycleTransition: "TERMINATING" },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           lifecycle
 *             .complete({
 *               LifecycleHookName: event.detail.LifecycleHookName,
 *               LifecycleActionToken: event.detail.LifecycleActionToken,
 *               LifecycleActionResult: "CONTINUE",
 *             })
 *             .pipe(Effect.orDie),
 *         ),
 *     );
 *
 *     return {};
 *   }).pipe(
 *     Effect.provide(
 *       Layer.mergeAll(AWS.Lambda.EventSource, CompleteLifecycleActionHttp),
 *     ),
 *   ),
 * );
 * ```
 */
export const consumeLifecycleActions = <StreamReq = never, Req = never>(
  group: AutoScalingGroup,
  props: LifecycleHookEventSourceProps,
  process: (
    events: Stream.Stream<LifecycleActionEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  Effect.gen(function* () {
    const transition = normalizeTransition(props.lifecycleTransition);
    const idPrefix = props.id ?? group.LogicalId;

    // Create the hook so instances actually pause and emit lifecycle events.
    const hook = yield* LifecycleHook(`${idPrefix}-LifecycleHook`, {
      autoScalingGroup: group,
      lifecycleHookName: props.lifecycleHookName,
      lifecycleTransition: props.lifecycleTransition,
      heartbeatTimeout: props.heartbeatTimeout,
      defaultResult: props.defaultResult,
      notificationMetadata: props.notificationMetadata,
    });

    // Subscribe the host Function to the matching lifecycle events. The pattern
    // uses only literal `source` + `detail-type` so it round-trips through both
    // the deploy-time rule and the runtime matcher (Output values cannot appear
    // in the pattern — they don't resolve inside the deployed bundle).
    yield* consumeBusEvents(
      `${idPrefix}-LifecycleEvents`,
      {
        source: ["aws.autoscaling"],
        "detail-type": [detailTypeFor(transition)],
      },
      process,
    );

    return hook;
  });
