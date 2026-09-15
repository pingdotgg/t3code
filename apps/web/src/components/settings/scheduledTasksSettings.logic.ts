import {
  EnvironmentId,
  type ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
  type ModelSelection,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type RuntimeMode,
  type ProviderInteractionMode,
  type ScheduledTaskSchedule,
  type ScheduledTaskUpdateInput,
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

export type ScheduleMode = "fixed" | "interval";
export type WorkspaceMode = "root" | "worktree" | "existing_worktree";

export interface DraftState {
  readonly editingId: string | null;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly scheduleMode: ScheduleMode;
  readonly intervalMinutes: string;
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
  /**
   * The task's original workspace strategy. The dialog only edits the mode,
   * base ref, origin flag, and checkout path; keeping the source object
   * preserves fields the controls cannot express (branch, …) when a
   * workspace edit is saved.
   */
  readonly baseWorkspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy | null;
}

const ALL_WEEKDAYS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 5, 6]);

export const EMPTY_DRAFT: DraftState = {
  editingId: null,
  title: "",
  prompt: "",
  enabled: true,
  scheduleMode: "fixed",
  intervalMinutes: "15",
  timeOfDay: "09:00",
  weekdays: new Set([1, 2, 3, 4, 5]),
  projectId: "",
  threadId: "",
  workspaceMode: "worktree",
  baseRef: "main",
  startFromOrigin: true,
  existingWorktreePath: "",
  modelKey: "",
  runtimeMode: "full-access",
  interactionMode: "default",
  baseModelSelection: null,
  baseWorkspaceStrategy: null,
};

export function splitModelKey(value: string): ModelSelection | null {
  const index = value.indexOf(":");
  if (index <= 0 || index === value.length - 1) return null;
  return {
    instanceId: ProviderInstanceId.make(value.slice(0, index)),
    model: value.slice(index + 1),
  };
}

function modelKey(selection: ModelSelection): string {
  return `${selection.instanceId}:${selection.model}`;
}

export function workspaceStrategyReady(draft: DraftState): boolean {
  return (
    draft.workspaceMode !== "existing_worktree" || draft.existingWorktreePath.trim().length > 0
  );
}

export function workspaceStrategyFromDraft(
  draft: DraftState,
  base: OrchestrationV2ThreadLaunchWorkspaceStrategy | null = draft.baseWorkspaceStrategy,
): OrchestrationV2ThreadLaunchWorkspaceStrategy {
  // `base` carries the fields the editor cannot express: the task's live
  // strategy when building an edit patch, the draft's open-time baseline
  // elsewhere. A mode change still keeps the stored branch — the dialog has
  // no control for it, so dropping it would silently retarget future runs.
  const preservedBranch = base?.branch !== undefined ? { branch: base.branch } : {};
  if (draft.workspaceMode === "root") {
    return base?.type === "root" ? base : { type: "root", ...preservedBranch };
  }
  if (draft.workspaceMode === "existing_worktree") {
    const worktreePath = draft.existingWorktreePath.trim();
    return base?.type === "existing_worktree"
      ? { ...base, worktreePath }
      : { type: "existing_worktree", worktreePath, ...preservedBranch };
  }
  const baseRef = draft.baseRef.trim() || "main";
  return base?.type === "worktree"
    ? { ...base, baseRef, startFromOrigin: draft.startFromOrigin }
    : { type: "worktree", baseRef, startFromOrigin: draft.startFromOrigin, ...preservedBranch };
}

// The dialog has no thread picker, so a bound task's only expressible
// project move is unbind-and-move — the thread cannot follow across
// projects. The Project field surfaces this as a hint before saving.
export function moveDetachesThreadBinding(draft: DraftState, baseline: DraftState): boolean {
  return draft.threadId !== "" && draft.projectId !== baseline.projectId;
}

export function scheduleFromDraft(draft: DraftState): ScheduledTaskSchedule {
  if (draft.scheduleMode === "interval") {
    const everyMs = Math.round(Number(draft.intervalMinutes) * 60_000);
    return { type: "interval", everyMs };
  }
  const selectedEveryDay = draft.weekdays.size === 0 || draft.weekdays.size === 7;
  return {
    type: "fixed_time",
    timeOfDay: draft.timeOfDay || "09:00",
    ...(selectedEveryDay ? {} : { weekdays: [...draft.weekdays].toSorted() }),
  };
}

export function taskToDraft(task: ScheduledTask): DraftState {
  const schedule = task.schedule;
  const weekdays =
    schedule.type === "fixed_time" && schedule.weekdays && schedule.weekdays.length > 0
      ? new Set(schedule.weekdays)
      : new Set(ALL_WEEKDAYS);
  return {
    editingId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    scheduleMode: schedule.type === "interval" ? "interval" : "fixed",
    intervalMinutes:
      schedule.type === "interval"
        ? String(Math.max(1, Math.round(schedule.everyMs / 60_000)))
        : "15",
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
    modelKey: modelKey(task.modelSelection),
    runtimeMode: task.runtimeMode,
    interactionMode: task.interactionMode,
    baseModelSelection: task.modelSelection,
    baseWorkspaceStrategy: task.workspaceStrategy,
  };
}

// Mirrors the server's isSameSchedule: order and duplicates are irrelevant and
// an empty/omitted weekday mask means the same as all seven days — daily.
function weekdayKey(weekdays: ReadonlyArray<number> | undefined): string {
  const unique = [...new Set(weekdays ?? [])].toSorted((x, y) => x - y);
  if (unique.length === 0 || unique.length === 7) return "daily";
  return unique.join(",");
}

function sameSchedule(a: ScheduledTaskSchedule, b: ScheduledTaskSchedule): boolean {
  if (a.type === "interval") {
    return b.type === "interval" && a.everyMs === b.everyMs;
  }
  return (
    b.type === "fixed_time" &&
    a.timeOfDay === b.timeOfDay &&
    weekdayKey(a.weekdays) === weekdayKey(b.weekdays)
  );
}

function sameWorkspaceStrategy(
  a: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  b: OrchestrationV2ThreadLaunchWorkspaceStrategy,
): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "worktree" && b.type === "worktree") {
    return a.baseRef === b.baseRef && a.startFromOrigin === b.startFromOrigin;
  }
  if (a.type === "existing_worktree" && b.type === "existing_worktree") {
    return a.worktreePath === b.worktreePath;
  }
  return true;
}

// The update RPC replaces the whole strategy object, so an edit patch is
// built on the task's live strategy rather than the open-time baseline:
// only sub-fields the draft changed are overlaid, and a concurrent write to
// an unedited field — including ones the editor cannot express, like a
// server-assigned branch — survives the save.
function workspaceStrategyEdit(
  live: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  draft: DraftState,
  baseline: DraftState,
): OrchestrationV2ThreadLaunchWorkspaceStrategy {
  const next = workspaceStrategyFromDraft(draft, live);
  if (next.type === "worktree" && live.type === "worktree") {
    return {
      ...live,
      baseRef: draft.baseRef.trim() !== baseline.baseRef.trim() ? next.baseRef : live.baseRef,
      startFromOrigin:
        draft.startFromOrigin !== baseline.startFromOrigin
          ? next.startFromOrigin
          : live.startFromOrigin,
    };
  }
  if (next.type === "existing_worktree" && live.type === "existing_worktree") {
    return {
      ...live,
      worktreePath:
        draft.existingWorktreePath.trim() !== baseline.existingWorktreePath.trim()
          ? next.worktreePath
          : live.worktreePath,
    };
  }
  return next;
}

/**
 * Partial update carrying only the fields the user changed since the editor
 * opened, scoped to the task's current project. `baseline` is the draft as it
 * was when the editor opened — not the live task — so a concurrent edit
 * landing mid-session is never read as a change the user made, and draft
 * round-trip conversions (interval granularity, dropped workspace flags)
 * can't manufacture dirty fields. Returns null when nothing changed so
 * callers can skip the round trip entirely. Only `nextProjectId` may re-home
 * the task; `projectId` stays the server's lookup and authorization scope.
 */
export function buildScheduledTaskUpdateInput(
  draft: DraftState,
  baseline: DraftState,
  task: ScheduledTask,
  modelSelection: ModelSelection,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
): ScheduledTaskUpdateInput | null {
  const patch: {
    -readonly [
      K in Exclude<keyof ScheduledTaskUpdateInput, "id" | "projectId">
    ]?: ScheduledTaskUpdateInput[K];
  } = {};
  const title = draft.title.trim();
  if (title !== baseline.title.trim()) patch.title = title as ScheduledTaskUpdateInput["title"];
  const prompt = draft.prompt.trim();
  if (prompt !== baseline.prompt.trim()) {
    patch.prompt = prompt as ScheduledTaskUpdateInput["prompt"];
  }
  if (draft.enabled !== baseline.enabled) patch.enabled = draft.enabled;
  const schedule = scheduleFromDraft(draft);
  if (!sameSchedule(schedule, scheduleFromDraft(baseline))) patch.schedule = schedule;
  if (!sameWorkspaceStrategy(workspaceStrategy, workspaceStrategyFromDraft(baseline))) {
    patch.workspaceStrategy = workspaceStrategyEdit(task.workspaceStrategy, draft, baseline);
  }
  if (draft.modelKey !== baseline.modelKey) patch.modelSelection = modelSelection;
  if (draft.projectId !== baseline.projectId) {
    patch.nextProjectId = draft.projectId as ProjectId;
  }
  // A binding cannot survive a real project move — the thread stays in the
  // old project and the server rejects the mismatched pair. The dialog has
  // no thread picker, so it can only ever detach, and it does so only when
  // the patch itself re-homes the task: a binding another client committed
  // mid-session (move + rebind) survives a stale save.
  if (
    patch.nextProjectId !== undefined &&
    patch.nextProjectId !== task.projectId &&
    task.threadId !== null
  ) {
    patch.threadId = null;
  }
  if (Object.keys(patch).length === 0) return null;
  return { id: task.id, projectId: task.projectId, ...patch };
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
