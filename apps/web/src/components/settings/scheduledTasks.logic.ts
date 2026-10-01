import { MIN_SCHEDULED_TASK_INTERVAL_MS } from "@t3tools/contracts";
import type {
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  ScheduledTask,
  ScheduledTaskSchedule,
  ScheduledTaskUpdateInput,
} from "@t3tools/contracts";

import { scheduleFromDraft, type DraftState } from "./scheduledTasksSettings.logic";

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

export { scheduleFromDraft } from "./scheduledTasksSettings.logic";

// Mirrors the server's isSameSchedule: order and duplicates are irrelevant and
// an empty/omitted weekday mask means the same as all seven days — daily.
function weekdayKey(weekdays: ReadonlyArray<number> | undefined): string {
  const unique = [...new Set(weekdays ?? [])].toSorted((x, y) => x - y);
  if (unique.length === 0 || unique.length === 7) return "daily";
  return unique.join(",");
}

function sameSchedule(a: ScheduledTaskSchedule, b: ScheduledTaskSchedule): boolean {
  if (a.maxRuns !== b.maxRuns) return false;
  if (a.type === "interval") {
    return (
      b.type === "interval" &&
      a.everyMs === b.everyMs &&
      weekdayKey(a.weekdays) === weekdayKey(b.weekdays) &&
      a.window?.start === b.window?.start &&
      a.window?.end === b.window?.end
    );
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

/** The schedule a save sends, or undefined when the live schedule stays. */
function scheduleToSave(
  draft: DraftState,
  baseline: DraftState,
  task: ScheduledTask,
): ScheduledTaskSchedule | undefined {
  const schedule = scheduleFromDraft(draft);
  return !sameSchedule(schedule, scheduleFromDraft(baseline)) ||
    // taskToDraft clamps a legacy sub-minute interval to one minute, so the
    // baseline diff cannot see the normalization the editor promises. Emit
    // the normalized schedule while the live task still carries it — a
    // concurrent write to a valid interval clears this condition instead
    // of being overwritten.
    (task.schedule.type === "interval" && task.schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS)
    ? schedule
    : undefined;
}

/**
 * The editor's Enabled switch, matching what a save produces: the user's
 * choice once they used it, otherwise the live task's state, and off and
 * locked while the cap the saved schedule will carry is used up.
 */
export function editorEnabledSwitch(
  draft: DraftState,
  baseline: DraftState,
  live: ScheduledTask | null,
): { readonly checked: boolean; readonly locked: boolean } {
  if (live === null) return { checked: draft.enabled, locked: false };
  const cap = (scheduleToSave(draft, baseline, live) ?? live.schedule).maxRuns;
  const locked = cap !== undefined && live.runCount >= cap;
  const enabled = draft.enabledTouched ? draft.enabled : live.enabled;
  return { checked: enabled && !locked, locked };
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
  if (draft.enabledTouched && draft.enabled !== task.enabled) patch.enabled = draft.enabled;
  const schedule = scheduleToSave(draft, baseline, task);
  if (schedule !== undefined) patch.schedule = schedule;
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
      // Send only the controls the user changed: the server merges the
      // sparse patch into the live strategy inside the update transaction,
      // so a concurrent edit to an untouched control — or to a field the
      // dialog cannot express (`branch`) — survives on both sides.
      patch.workspaceStrategyPatch = {
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
      patch.workspaceStrategyPatch = { worktreePath: workspaceStrategy.worktreePath };
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
