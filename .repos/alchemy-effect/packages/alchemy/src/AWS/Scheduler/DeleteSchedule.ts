import type * as scheduler from "@distilled.cloud/aws/scheduler";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ScheduleGroup } from "./ScheduleGroup.ts";

export interface DeleteScheduleRequest extends Omit<
  scheduler.DeleteScheduleInput,
  "GroupName"
> {}

/**
 * Runtime binding for `scheduler:DeleteSchedule`.
 *
 * Pairs with {@link CreateSchedule} for the dynamic-scheduling pattern: a
 * deployed Lambda deletes schedules it minted at runtime (cancel a reminder,
 * clean up a completed one-shot). Optionally scoped to a `ScheduleGroup`;
 * without one it covers the default group.
 * @binding
 * @section Deleting Schedules At Runtime
 * @example Cancel A Reminder
 * ```typescript
 * const deleteSchedule = yield* AWS.Scheduler.DeleteSchedule();
 *
 * // runtime
 * yield* deleteSchedule({ Name: `reminder-${userId}` }).pipe(
 *   // already gone — cancellation is idempotent
 *   Effect.catchTag("ResourceNotFoundException", () => Effect.void),
 * );
 * ```
 *
 * @example Scope Deletion To A Schedule Group
 * ```typescript
 * const deleteSchedule = yield* AWS.Scheduler.DeleteSchedule(group);
 * ```
 */
export interface DeleteSchedule extends Binding.Service<
  DeleteSchedule,
  "AWS.Scheduler.DeleteSchedule",
  (
    group?: ScheduleGroup,
  ) => Effect.Effect<
    (
      request: DeleteScheduleRequest,
    ) => Effect.Effect<
      scheduler.DeleteScheduleOutput,
      scheduler.DeleteScheduleError
    >
  >
> {}
export const DeleteSchedule = Binding.Service<DeleteSchedule>(
  "AWS.Scheduler.DeleteSchedule",
);
