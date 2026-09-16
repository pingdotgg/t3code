import type {
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ScheduledTask,
  ScheduledTaskSchedule,
  ScheduledTaskUpdateInput,
  ThreadId,
} from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";

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
   * base ref, and checkout path; keeping the source object preserves fields
   * the controls cannot express (branch, startFromOrigin) when a workspace
   * edit is saved.
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
  existingWorktreePath: "",
  modelKey: "",
  runtimeMode: "full-access",
  interactionMode: "default",
  baseModelSelection: null,
  baseWorkspaceStrategy: null,
};

function modelKey(selection: ModelSelection): string {
  return `${selection.instanceId}:${selection.model}`;
}

export function splitModelKey(value: string): ModelSelection | null {
  const index = value.indexOf(":");
  if (index <= 0 || index === value.length - 1) return null;
  return {
    instanceId: ProviderInstanceId.make(value.slice(0, index)),
    model: value.slice(index + 1),
  };
}

// "Use a specific checkout" requires a path — the contract is
// TrimmedNonEmptyString, so a blank field would produce a strategy the server
// rejects at validation. Submit gates on this before building anything.
export function workspaceStrategyReady(draft: DraftState): boolean {
  return (
    draft.workspaceMode !== "existing_worktree" || draft.existingWorktreePath.trim().length > 0
  );
}

export function workspaceStrategyFromDraft(
  draft: DraftState,
): OrchestrationV2ThreadLaunchWorkspaceStrategy {
  const base = draft.baseWorkspaceStrategy;
  if (draft.workspaceMode === "root") {
    return base?.type === "root" ? base : { type: "root" };
  }
  if (draft.workspaceMode === "existing_worktree") {
    const worktreePath = draft.existingWorktreePath.trim();
    return base?.type === "existing_worktree"
      ? { ...base, worktreePath }
      : { type: "existing_worktree", worktreePath };
  }
  const baseRef = draft.baseRef.trim() || "main";
  return base?.type === "worktree"
    ? { ...base, baseRef }
    : { type: "worktree", baseRef, startFromOrigin: true };
}

// The dialog has no thread picker, so a bound task's only expressible
// project move is unbind-and-move — the thread cannot follow across
// projects. The Project field surfaces this as a hint before saving.
export function moveDetachesThreadBinding(draft: DraftState, baseline: DraftState): boolean {
  return draft.threadId !== "" && draft.projectId !== baseline.projectId;
}

export function scheduleFromDraft(draft: DraftState): ScheduledTaskSchedule {
  if (draft.scheduleMode === "interval") {
    const minutes = Math.max(1, Number.parseInt(draft.intervalMinutes, 10) || 1);
    return { type: "interval", everyMs: minutes * 60_000 };
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
  const threadId = draft.threadId || null;
  // A binding cannot survive a project move — the thread stays in the old
  // project and the server rejects the mismatched pair. The dialog has no
  // thread picker, so the only expressible move is unbind-and-move.
  const nextThreadId = moveDetachesThreadBinding(draft, baseline)
    ? null
    : (threadId as ThreadId | null);
  if (nextThreadId !== (baseline.threadId || null)) patch.threadId = nextThreadId;
  if (!sameWorkspaceStrategy(workspaceStrategy, workspaceStrategyFromDraft(baseline))) {
    patch.workspaceStrategy = workspaceStrategy;
  }
  if (draft.modelKey !== baseline.modelKey) patch.modelSelection = modelSelection;
  if (draft.projectId !== baseline.projectId) {
    patch.nextProjectId = draft.projectId as ProjectId;
  }
  if (Object.keys(patch).length === 0) return null;
  return { id: task.id, projectId: task.projectId, ...patch };
}
