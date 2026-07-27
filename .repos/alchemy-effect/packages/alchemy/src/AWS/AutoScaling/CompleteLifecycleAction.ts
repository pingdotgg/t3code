import type * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AutoScalingGroup } from "./AutoScalingGroup.ts";

/**
 * Signal the result of a paused lifecycle action. The Auto Scaling group name is
 * injected by the binding; supply the hook name, the action token (from the
 * lifecycle event) or instance id, and the result.
 */
export interface CompleteLifecycleActionRequest extends Omit<
  autoscaling.CompleteLifecycleActionType,
  "AutoScalingGroupName"
> {}

/**
 * Extend the heartbeat timeout on a paused lifecycle action. The Auto Scaling
 * group name is injected by the binding.
 */
export interface RecordLifecycleActionHeartbeatRequest extends Omit<
  autoscaling.RecordLifecycleActionHeartbeatType,
  "AutoScalingGroupName"
> {}

export interface CompleteLifecycleActionClient {
  /**
   * Signal `CONTINUE` or `ABANDON` on a paused lifecycle action so the instance
   * transition proceeds instead of waiting for the heartbeat timeout.
   */
  complete: (
    request: CompleteLifecycleActionRequest,
  ) => Effect.Effect<
    autoscaling.CompleteLifecycleActionAnswer,
    autoscaling.CompleteLifecycleActionError
  >;
  /**
   * Extend the wait state by resetting the heartbeat timeout, buying more time
   * before the hook's `defaultResult` is applied.
   */
  heartbeat: (
    request: RecordLifecycleActionHeartbeatRequest,
  ) => Effect.Effect<
    autoscaling.RecordLifecycleActionHeartbeatAnswer,
    autoscaling.RecordLifecycleActionHeartbeatError
  >;
}

/**
 * A write binding that lets a Function/Instance complete or heartbeat paused
 * lifecycle actions on an Auto Scaling Group. Grants
 * `autoscaling:CompleteLifecycleAction` and
 * `autoscaling:RecordLifecycleActionHeartbeat` scoped to the group ARN.
 *
 * @binding
 * @section Completing Lifecycle Actions
 * @example Signal CONTINUE from a lifecycle handler
 * ```typescript
 * const lifecycle = yield* CompleteLifecycleAction(group);
 * yield* lifecycle.complete({
 *   LifecycleHookName: event.detail.LifecycleHookName,
 *   LifecycleActionToken: event.detail.LifecycleActionToken,
 *   LifecycleActionResult: "CONTINUE",
 * });
 * ```
 *
 * @example Drain launching instances from a Lambda Function
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 * import {
 *   CompleteLifecycleAction,
 *   CompleteLifecycleActionHttp,
 *   consumeLifecycleActions,
 * } from "alchemy/AWS/AutoScaling";
 *
 * export class LifecycleFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
 *   "LifecycleFunction",
 * ) {}
 *
 * export default LifecycleFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const lifecycle = yield* CompleteLifecycleAction(group);
 *
 *     yield* consumeLifecycleActions(
 *       group,
 *       { lifecycleTransition: "LAUNCHING", heartbeatTimeout: "300 seconds" },
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
 *
 * @example Buy more time with a heartbeat
 * ```typescript
 * // reset the heartbeat timeout while a long drain is still in progress
 * yield* lifecycle.heartbeat({
 *   LifecycleHookName: event.detail.LifecycleHookName,
 *   LifecycleActionToken: event.detail.LifecycleActionToken,
 * });
 * ```
 */
export interface CompleteLifecycleAction extends Binding.Service<
  CompleteLifecycleAction,
  "AWS.AutoScaling.CompleteLifecycleAction",
  (group: AutoScalingGroup) => Effect.Effect<CompleteLifecycleActionClient>
> {}

export const CompleteLifecycleAction = Binding.Service<CompleteLifecycleAction>(
  "AWS.AutoScaling.CompleteLifecycleAction",
);
