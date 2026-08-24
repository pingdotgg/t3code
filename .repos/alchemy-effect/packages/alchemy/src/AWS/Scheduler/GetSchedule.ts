import type * as scheduler from "@distilled.cloud/aws/scheduler";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ScheduleGroup } from "./ScheduleGroup.ts";

export interface GetScheduleRequest extends Omit<
  scheduler.GetScheduleInput,
  "GroupName"
> {}

/**
 * Runtime binding for `scheduler:GetSchedule`.
 *
 * Pairs with {@link CreateSchedule} for the dynamic-scheduling pattern: a
 * deployed Lambda inspects schedules it minted at runtime (is the reminder
 * still pending?). Optionally scoped to a `ScheduleGroup`; without one it
 * covers the default group.
 * @binding
 * @section Reading Schedules At Runtime
 * @example Check A Pending Reminder
 * ```typescript
 * const getSchedule = yield* AWS.Scheduler.GetSchedule();
 *
 * // runtime
 * const schedule = yield* getSchedule({ Name: `reminder-${userId}` });
 * console.log(schedule.State, schedule.ScheduleExpression);
 * ```
 *
 * @example Scope Reads To A Schedule Group
 * ```typescript
 * const getSchedule = yield* AWS.Scheduler.GetSchedule(group);
 * ```
 */
export interface GetSchedule extends Binding.Service<
  GetSchedule,
  "AWS.Scheduler.GetSchedule",
  (
    group?: ScheduleGroup,
  ) => Effect.Effect<
    (
      request: GetScheduleRequest,
    ) => Effect.Effect<scheduler.GetScheduleOutput, scheduler.GetScheduleError>
  >
> {}
export const GetSchedule = Binding.Service<GetSchedule>(
  "AWS.Scheduler.GetSchedule",
);
