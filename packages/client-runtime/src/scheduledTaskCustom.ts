import type { ScheduledTaskSchedule, ScheduledTaskUpsertCustomSchedule } from "@t3tools/contracts";

export interface CustomScheduleDraft {
  readonly expression: string;
  readonly timeZone: string;
  readonly startAt: string;
}

export const EMPTY_CUSTOM_SCHEDULE_DRAFT: CustomScheduleDraft = {
  expression: "",
  timeZone: "",
  startAt: "",
};

export function customScheduleDraft(schedule: ScheduledTaskSchedule): CustomScheduleDraft {
  return schedule.type === "custom"
    ? { expression: schedule.expression, timeZone: schedule.timeZone, startAt: schedule.startAt }
    : EMPTY_CUSTOM_SCHEDULE_DRAFT;
}

/** Blank zone and start are omitted so the server keeps the saved values or picks defaults. */
export function customScheduleFromDraft(
  draft: CustomScheduleDraft,
): ScheduledTaskUpsertCustomSchedule {
  const timeZone = draft.timeZone.trim();
  const startAt = draft.startAt.trim();
  return {
    type: "custom",
    expression: draft.expression.trim(),
    ...(timeZone ? { timeZone } : {}),
    ...(startAt ? { startAt } : {}),
  };
}
