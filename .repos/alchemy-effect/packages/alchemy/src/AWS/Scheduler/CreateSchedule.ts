import type * as scheduler from "@distilled.cloud/aws/scheduler";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Role } from "../IAM/Role.ts";
import type { ScheduleGroup } from "./ScheduleGroup.ts";

/**
 * The schedule target passed at runtime. `RoleArn` defaults to the execution
 * role the binding was constructed with, so callers normally omit it.
 */
export interface CreateScheduleTarget extends Omit<
  scheduler.Target,
  "RoleArn"
> {
  /**
   * Execution role EventBridge Scheduler assumes to invoke the target.
   * @default the execution role bound via `CreateSchedule(role)`
   */
  RoleArn?: string;
}

export interface CreateScheduleRequest extends Omit<
  scheduler.CreateScheduleInput,
  "GroupName" | "Target" | "FlexibleTimeWindow"
> {
  /**
   * Target the schedule invokes when it fires. The bound execution role is
   * injected as `RoleArn` unless the request overrides it.
   */
  Target: CreateScheduleTarget;
  /**
   * Flexible time window configuration.
   * @default { Mode: "OFF" }
   */
  FlexibleTimeWindow?: scheduler.FlexibleTimeWindow;
}

/**
 * Runtime binding for `scheduler:CreateSchedule` — THE dynamic-scheduling
 * pattern (per-user reminders, delayed callbacks): a deployed Lambda mints
 * one-shot `at(...)` or recurring schedules at runtime.
 *
 * The binding is constructed with the schedule **execution role** (the IAM
 * role EventBridge Scheduler assumes to invoke the target) and, optionally, a
 * `ScheduleGroup` that scopes which schedules the host may create. At deploy
 * time it contributes BOTH `scheduler:CreateSchedule` on the group's schedule
 * ARN pattern AND `iam:PassRole` on the execution role — without the PassRole
 * statement schedule creation fails only at runtime.
 * @binding
 * @section Creating Schedules At Runtime
 * @example Mint A One-Shot Schedule From A Lambda
 * ```typescript
 * // deploy time: pre-create the execution role Scheduler will assume
 * const role = yield* AWS.IAM.Role("ReminderRole", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { Service: "scheduler.amazonaws.com" },
 *         Action: ["sts:AssumeRole"],
 *       },
 *     ],
 *   },
 *   inlinePolicies: {
 *     SendReminder: {
 *       Version: "2012-10-17",
 *       Statement: [
 *         {
 *           Effect: "Allow",
 *           Action: ["sqs:SendMessage"],
 *           Resource: [queue.queueArn],
 *         },
 *       ],
 *     },
 *   },
 * });
 * const createSchedule = yield* AWS.Scheduler.CreateSchedule(role);
 *
 * // runtime: schedule a one-shot delivery in 15 minutes
 * const queueArn = yield* queue.queueArn;
 * yield* createSchedule({
 *   Name: `reminder-${userId}`,
 *   ScheduleExpression: "at(2026-01-01T00:00:00)",
 *   ActionAfterCompletion: "DELETE",
 *   Target: {
 *     Arn: yield* queueArn,
 *     Input: JSON.stringify({ userId }),
 *   },
 * });
 * ```
 *
 * @example Scope Creation To A Schedule Group
 * ```typescript
 * const group = yield* AWS.Scheduler.ScheduleGroup("Reminders", {});
 * const createSchedule = yield* AWS.Scheduler.CreateSchedule(role, group);
 * // runtime calls create schedules inside the group only
 * ```
 */
export interface CreateSchedule extends Binding.Service<
  CreateSchedule,
  "AWS.Scheduler.CreateSchedule",
  <R extends Role>(
    executionRole: R,
    group?: ScheduleGroup,
  ) => Effect.Effect<
    (
      request: CreateScheduleRequest,
    ) => Effect.Effect<
      scheduler.CreateScheduleOutput,
      scheduler.CreateScheduleError
    >
  >
> {}
export const CreateSchedule = Binding.Service<CreateSchedule>(
  "AWS.Scheduler.CreateSchedule",
);
