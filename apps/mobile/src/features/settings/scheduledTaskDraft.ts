import type { ScheduledTask, ScheduledTaskUpsertSchedule } from "@t3tools/contracts";

export type ScheduleDraft = {
  readonly mode: "fixed_time" | "interval";
  readonly timeOfDay: string;
  readonly weekdays: ReadonlyArray<number>;
  readonly intervalMinutes: string;
};

export const DEFAULT_SCHEDULE: ScheduleDraft = {
  mode: "fixed_time",
  timeOfDay: "09:00",
  weekdays: [1, 2, 3, 4, 5],
  intervalMinutes: "15",
};

export function scheduleDraftForTask(task: ScheduledTask): ScheduleDraft {
  return task.schedule.type === "fixed_time"
    ? {
        ...DEFAULT_SCHEDULE,
        timeOfDay: task.schedule.timeOfDay,
        weekdays: task.schedule.weekdays?.length
          ? [...task.schedule.weekdays]
          : [0, 1, 2, 3, 4, 5, 6],
      }
    : {
        ...DEFAULT_SCHEDULE,
        mode: "interval",
        intervalMinutes: String(task.schedule.everyMs / 60_000),
      };
}

export function scheduleFromDraft(draft: ScheduleDraft): ScheduledTaskUpsertSchedule | null {
  if (draft.mode === "interval") {
    const minutes = Number(draft.intervalMinutes);
    return Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= 1_000_000
      ? { type: "interval", everyMs: minutes * 60_000 }
      : null;
  }
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(draft.timeOfDay) || draft.weekdays.length === 0) {
    return null;
  }
  return {
    type: "fixed_time",
    timeOfDay: draft.timeOfDay,
    ...(draft.weekdays.length === 7 ? {} : { weekdays: [...draft.weekdays].sort((a, b) => a - b) }),
  };
}
