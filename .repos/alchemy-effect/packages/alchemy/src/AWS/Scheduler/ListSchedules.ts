import type * as scheduler from "@distilled.cloud/aws/scheduler";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ScheduleGroup } from "./ScheduleGroup.ts";

export interface ListSchedulesRequest extends Omit<
  scheduler.ListSchedulesInput,
  "GroupName"
> {}

/**
 * Runtime binding for `scheduler:ListSchedules`.
 *
 * Pairs with {@link CreateSchedule} for the dynamic-scheduling pattern: a
 * deployed Lambda enumerates the schedules it minted at runtime (sweep
 * pending reminders, count outstanding one-shots). Listing is always scoped
 * to the bound `ScheduleGroup` — or the `default` group when none is given.
 * Note: IAM evaluates `scheduler:ListSchedules` against the account-wide
 * `schedule/*​/*` pattern (not the group), so the binding grants on that
 * pattern while the request's `GroupName` filter keeps results group-scoped.
 * @binding
 * @section Listing Schedules At Runtime
 * @example Sweep Pending Reminders
 * ```typescript
 * const listSchedules = yield* AWS.Scheduler.ListSchedules();
 *
 * // runtime: enumerate this app's runtime-minted reminders
 * const page = yield* listSchedules({ NamePrefix: "reminder-" });
 * for (const schedule of page.Schedules) {
 *   console.log(schedule.Name, schedule.State);
 * }
 * ```
 *
 * @example Scope Listing To A Schedule Group
 * ```typescript
 * const listSchedules = yield* AWS.Scheduler.ListSchedules(group);
 * ```
 */
export interface ListSchedules extends Binding.Service<
  ListSchedules,
  "AWS.Scheduler.ListSchedules",
  (
    group?: ScheduleGroup,
  ) => Effect.Effect<
    (
      request?: ListSchedulesRequest,
    ) => Effect.Effect<
      scheduler.ListSchedulesOutput,
      scheduler.ListSchedulesError
    >
  >
> {}
export const ListSchedules = Binding.Service<ListSchedules>(
  "AWS.Scheduler.ListSchedules",
);
