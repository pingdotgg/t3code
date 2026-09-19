import type {
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  ScheduledTask,
  ScheduledTaskSchedule,
  ScheduledTaskUpdateInput,
} from "@t3tools/contracts";

import type { DraftState } from "./scheduledTasksSettings.logic";

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
  if (draft.workspaceMode === "root") return { type: "root" };
  if (draft.workspaceMode === "existing_worktree") {
    return { type: "existing_worktree", worktreePath: draft.existingWorktreePath.trim() };
  }
  return {
    type: "worktree",
    baseRef: draft.baseRef.trim() || "main",
    startFromOrigin: draft.startFromOrigin,
  };
}

// The dialog has no thread picker, so a bound task's only expressible
// project move is unbind-and-move — the thread cannot follow across
// projects. The Project field surfaces this as a hint before saving.
export function moveDetachesThreadBinding(draft: DraftState, baseline: DraftState): boolean {
  return draft.threadId !== "" && draft.projectId !== baseline.projectId;
}

export function scheduleFromDraft(draft: DraftState): ScheduledTaskSchedule {
  if (draft.scheduleMode === "interval") {
    // Fractional minutes are valid input (the create path permits them), so
    // truncate-free conversion matters for both diffing and the saved value.
    const minutes = Math.max(1, Number(draft.intervalMinutes) || 1);
    return { type: "interval", everyMs: Math.round(minutes * 60_000) };
  }
  const selectedEveryDay = draft.weekdays.size === 0 || draft.weekdays.size === 7;
  return {
    type: "fixed_time",
    timeOfDay: draft.timeOfDay || "09:00",
    ...(selectedEveryDay ? {} : { weekdays: [...draft.weekdays].toSorted() }),
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
 * round-trip conversions (interval granularity) can't manufacture dirty
 * fields. Returns null when nothing changed so callers can skip the round
 * trip entirely. Only `nextProjectId` may re-home the task; `projectId` stays
 * the server's lookup and authorization scope.
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
  const baselineStrategy = workspaceStrategyFromDraft(baseline);
  if (!sameWorkspaceStrategy(workspaceStrategy, baselineStrategy)) {
    if (workspaceStrategy.type !== baselineStrategy.type) {
      // The user switched workspace kind — the draft strategy is the intent.
      patch.workspaceStrategy = workspaceStrategy;
    } else if (
      workspaceStrategy.type === "worktree" &&
      baselineStrategy.type === "worktree" &&
      task.workspaceStrategy.type === "worktree"
    ) {
      // The dialog cannot express every strategy field (`branch`), so a
      // dirty workspace control overlays the live strategy instead of
      // replacing it — and only the controls the user changed, so a
      // concurrent edit to an untouched control survives a stale save.
      patch.workspaceStrategy = {
        ...task.workspaceStrategy,
        ...(workspaceStrategy.baseRef !== baselineStrategy.baseRef
          ? { baseRef: workspaceStrategy.baseRef }
          : {}),
        ...(workspaceStrategy.startFromOrigin !== baselineStrategy.startFromOrigin
          ? { startFromOrigin: workspaceStrategy.startFromOrigin }
          : {}),
      };
    } else if (
      workspaceStrategy.type === "existing_worktree" &&
      baselineStrategy.type === "existing_worktree" &&
      task.workspaceStrategy.type === "existing_worktree"
    ) {
      patch.workspaceStrategy = {
        ...task.workspaceStrategy,
        ...(workspaceStrategy.worktreePath !== baselineStrategy.worktreePath
          ? { worktreePath: workspaceStrategy.worktreePath }
          : {}),
      };
    }
    // When the live kind no longer matches the opening kind a concurrent
    // editor switched it, so a stale control edit is dropped rather than
    // silently reverting that change.
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
