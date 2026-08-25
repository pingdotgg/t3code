import type * as scheduler from "@distilled.cloud/aws/scheduler";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Role } from "../IAM/Role.ts";
import type { ScheduleGroup } from "./ScheduleGroup.ts";

/**
 * The schedule target passed at runtime. `RoleArn` defaults to the execution
 * role the binding was constructed with, so callers normally omit it.
 */
export interface UpdateScheduleTarget extends Omit<
  scheduler.Target,
  "RoleArn"
> {
  /**
   * Execution role EventBridge Scheduler assumes to invoke the target.
   * @default the execution role bound via `UpdateSchedule(role)`
   */
  RoleArn?: string;
}

export interface UpdateScheduleRequest extends Omit<
  scheduler.UpdateScheduleInput,
  "GroupName" | "Target" | "FlexibleTimeWindow"
> {
  /**
   * Target the schedule invokes when it fires. The bound execution role is
   * injected as `RoleArn` unless the request overrides it.
   */
  Target: UpdateScheduleTarget;
  /**
   * Flexible time window configuration.
   * @default { Mode: "OFF" }
   */
  FlexibleTimeWindow?: scheduler.FlexibleTimeWindow;
}

/**
 * Runtime binding for `scheduler:UpdateSchedule`.
 *
 * Pairs with {@link CreateSchedule} for the dynamic-scheduling pattern: a
 * deployed Lambda reschedules or pauses schedules it minted at runtime (push
 * a reminder back, disable a recurring job). `UpdateSchedule` is a full PUT —
 * unspecified fields are reset to their defaults, so send the complete
 * desired configuration.
 *
 * Like {@link CreateSchedule}, the binding is constructed with the schedule
 * **execution role** and optionally a scoping `ScheduleGroup`; it contributes
 * both `scheduler:UpdateSchedule` on the group's schedule ARN pattern and
 * `iam:PassRole` on the execution role.
 * @binding
 * @section Updating Schedules At Runtime
 * @example Reschedule A Reminder
 * ```typescript
 * const updateSchedule = yield* AWS.Scheduler.UpdateSchedule(role);
 *
 * // runtime: push the reminder back a day (full PUT — resend the target)
 * yield* updateSchedule({
 *   Name: `reminder-${userId}`,
 *   ScheduleExpression: "at(2026-01-02T00:00:00)",
 *   ActionAfterCompletion: "DELETE",
 *   Target: {
 *     Arn: yield* queueArn,
 *     Input: JSON.stringify({ userId }),
 *   },
 * });
 * ```
 *
 * @example Scope Updates To A Schedule Group
 * ```typescript
 * const updateSchedule = yield* AWS.Scheduler.UpdateSchedule(role, group);
 * ```
 */
export interface UpdateSchedule extends Binding.Service<
  UpdateSchedule,
  "AWS.Scheduler.UpdateSchedule",
  <R extends Role>(
    executionRole: R,
    group?: ScheduleGroup,
  ) => Effect.Effect<
    (
      request: UpdateScheduleRequest,
    ) => Effect.Effect<
      scheduler.UpdateScheduleOutput,
      scheduler.UpdateScheduleError
    >
  >
> {}
export const UpdateSchedule = Binding.Service<UpdateSchedule>(
  "AWS.Scheduler.UpdateSchedule",
);
