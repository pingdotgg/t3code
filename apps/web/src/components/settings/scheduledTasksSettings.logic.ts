import {
  EnvironmentId,
  type ProjectId,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskSchedule,
  type ModelSelection,
  type RuntimeMode,
  type ProviderInteractionMode,
  type ServerSettings,
} from "@t3tools/contracts";

import {
  resolveProjectSettings,
  type LegacyProjectSettingsFields,
} from "@t3tools/shared/projectSettings";
import type { ProviderInstanceEntry } from "../../providerInstances";

import type { ResolvedSettingsScope } from "./settingsScope";

/** Project IDs belong to an environment, including when a grouped project spans machines. */
export function matchesScheduledTaskScope(
  scope: ResolvedSettingsScope,
  environmentId: EnvironmentId,
  projectId: ProjectId,
): boolean {
  if (scope.kind === "unavailable" || !scope.environmentIds.includes(environmentId)) return false;
  if (scope.kind === "project" || scope.kind === "checkout") {
    return scope.members.some(
      (member) => member.environmentId === environmentId && member.id === projectId,
    );
  }
  return true;
}

export function validateScheduledTasksSearch(raw: Record<string, unknown>) {
  return {
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.taskId === "string" && raw.taskId.trim()
      ? { taskId: ScheduledTaskId.make(raw.taskId) }
      : {}),
  };
}

type ScheduleMode = "fixed" | "interval";
export type WorkspaceMode = "root" | "worktree" | "existing_worktree";

export interface DraftState {
  readonly editingId: string | null;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: boolean;
  /**
   * Whether the user used the Enabled switch. Until then the editor shows the
   * live task's state and a save leaves enabled alone, so a cap pause or
   * another client's pause is never undone implicitly.
   */
  readonly enabledTouched: boolean;
  readonly scheduleMode: ScheduleMode;
  readonly intervalMinutes: string;
  /** Weekdays an interval schedule may run on; empty means every day. */
  readonly intervalWeekdays: ReadonlySet<number>;
  readonly windowEnabled: boolean;
  readonly windowStart: string;
  readonly windowEnd: string;
  /** Run cap as freeform input; empty string means no limit. */
  readonly maxRuns: string;
  readonly timeOfDay: string;
  readonly weekdays: ReadonlySet<number>;
  readonly projectId: string;
  readonly threadId: string;
  readonly workspaceMode: WorkspaceMode;
  readonly baseRef: string;
  readonly startFromOrigin: boolean;
  readonly existingWorktreePath: string;
  readonly modelKey: string;
  /** Not editable in the dialog, but preserved so editing an agent-created task keeps its modes. */
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /**
   * The task's original model selection. The picker only edits
   * `instanceId:model`; keeping the source object preserves provider options
   * (reasoning, temperature, …) when the model itself is left unchanged.
   */
  readonly baseModelSelection: ModelSelection | null;
}

/** Minutes since midnight; accepts the padded and unpadded forms the contract allows. */
function timeOfDayMinutes(value: string): number | null {
  if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(value.trim())) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

export function timeWindowValid(start: string, end: string): boolean {
  const startMinutes = timeOfDayMinutes(start);
  const endMinutes = timeOfDayMinutes(end);
  return startMinutes !== null && endMinutes !== null && startMinutes < endMinutes;
}

/** Parse the maxRuns input: undefined when unset, null when invalid, the cap otherwise. */
export function maxRunsFromDraft(value: string): number | null | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

/**
 * The optional restriction fields the draft contributes to a schedule: an
 * interval task takes weekdays, window and cap; a fixed-time task's weekdays
 * are part of its base shape, so only the cap applies. An invalid cap yields
 * no restrictions; submit blocks on it separately.
 */
function scheduleRestrictionsFromDraft(
  draft: DraftState,
): Pick<Extract<ScheduledTaskSchedule, { type: "interval" }>, "weekdays" | "window" | "maxRuns"> {
  const maxRuns = maxRunsFromDraft(draft.maxRuns);
  if (maxRuns === null) return {};
  const cap = maxRuns === undefined ? {} : { maxRuns };
  if (draft.scheduleMode !== "interval") return cap;
  const weekdays = [...draft.intervalWeekdays].toSorted();
  const everyDay = weekdays.length === 0 || weekdays.length === 7;
  return {
    ...(everyDay ? {} : { weekdays }),
    ...(draft.windowEnabled && timeWindowValid(draft.windowStart, draft.windowEnd)
      ? { window: { start: draft.windowStart, end: draft.windowEnd } }
      : {}),
    ...cap,
  };
}

export function scheduleFromDraft(draft: DraftState): ScheduledTaskSchedule {
  if (draft.scheduleMode === "interval") {
    const everyMs = Math.round(Number(draft.intervalMinutes) * 60_000);
    return { type: "interval", everyMs, ...scheduleRestrictionsFromDraft(draft) };
  }
  const selectedEveryDay = draft.weekdays.size === 0 || draft.weekdays.size === 7;
  return {
    type: "fixed_time",
    timeOfDay: draft.timeOfDay || "09:00",
    ...(selectedEveryDay ? {} : { weekdays: [...draft.weekdays].toSorted() }),
    ...scheduleRestrictionsFromDraft(draft),
  };
}

/** True when the task has finished its configured run cap. */
export function runCapReached(task: ScheduledTask): boolean {
  return task.schedule.maxRuns !== undefined && task.runCount >= task.schedule.maxRuns;
}

export function taskToDraft(task: ScheduledTask): DraftState {
  const schedule = task.schedule;
  const weekdays =
    schedule.type === "fixed_time" && schedule.weekdays && schedule.weekdays.length > 0
      ? new Set(schedule.weekdays)
      : new Set([0, 1, 2, 3, 4, 5, 6]);
  return {
    editingId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    enabledTouched: false,
    scheduleMode: schedule.type === "interval" ? "interval" : "fixed",
    intervalMinutes:
      schedule.type === "interval" ? String(Math.max(1, schedule.everyMs / 60_000)) : "15",
    intervalWeekdays: new Set(schedule.type === "interval" ? (schedule.weekdays ?? []) : []),
    windowEnabled: schedule.type === "interval" && schedule.window !== undefined,
    windowStart: schedule.type === "interval" && schedule.window ? schedule.window.start : "09:00",
    windowEnd: schedule.type === "interval" && schedule.window ? schedule.window.end : "17:00",
    maxRuns: schedule.maxRuns === undefined ? "" : String(schedule.maxRuns),
    timeOfDay: schedule.type === "fixed_time" ? schedule.timeOfDay : "09:00",
    weekdays,
    projectId: task.projectId,
    threadId: task.threadId ?? "",
    workspaceMode: task.workspaceStrategy.type,
    baseRef: task.workspaceStrategy.type === "worktree" ? task.workspaceStrategy.baseRef : "main",
    startFromOrigin:
      task.workspaceStrategy.type === "worktree"
        ? (task.workspaceStrategy.startFromOrigin ?? false)
        : true,
    existingWorktreePath:
      task.workspaceStrategy.type === "existing_worktree"
        ? task.workspaceStrategy.worktreePath
        : "",
    modelKey: `${task.modelSelection.instanceId}:${task.modelSelection.model}`,
    runtimeMode: task.runtimeMode,
    interactionMode: task.interactionMode,
    baseModelSelection: task.modelSelection,
  };
}

/** Use configured defaults before the catalog's advertised default model. */
export function scheduledTaskDefaultModel(
  settings: ServerSettings,
  project: (LegacyProjectSettingsFields & { readonly id: ProjectId }) | null,
  entries: readonly ProviderInstanceEntry[],
): ModelSelection | null {
  const available = entries.filter(
    (entry) =>
      entry.enabled &&
      entry.installed &&
      entry.isAvailable &&
      entry.snapshot.auth.status !== "unauthenticated",
  );
  const configured = resolveProjectSettings(settings, project?.id ?? null, project).settings
    .defaultModelSelection;
  for (const selection of [configured, settings.defaultModelSelection]) {
    if (
      selection &&
      available.some(
        (entry) =>
          entry.instanceId === selection.instanceId &&
          entry.models.find((model) => model.slug === selection.model)?.isLegacy !== true,
      )
    )
      return selection;
  }
  const models = available.flatMap((entry) =>
    entry.models
      .filter((model) => !model.isLegacy)
      .map((model) => ({ instanceId: entry.instanceId, model })),
  );
  const fallback = models.find(({ model }) => model.isDefault) ?? models[0];
  return fallback ? { instanceId: fallback.instanceId, model: fallback.model.slug } : null;
}
