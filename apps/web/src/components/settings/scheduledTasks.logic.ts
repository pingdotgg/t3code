import { MIN_SCHEDULED_TASK_INTERVAL_MS } from "@t3tools/contracts";
import type {
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  ScheduledTask,
  ScheduledTaskUpdateInput,
  ScheduledTaskUpsertSchedule,
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

// A project move must detach the binding; the dialog has no thread picker.
// Use the live task so concurrent bindings are included in the hint.
export function moveDetachesThreadBinding(
  draft: DraftState,
  baseline: DraftState,
  task: ScheduledTask | undefined,
): boolean {
  return (
    task !== undefined &&
    task.threadId !== null &&
    draft.projectId !== baseline.projectId &&
    draft.projectId !== task.projectId
  );
}

// Mirrors the server's isSameSchedule: order and duplicates are irrelevant and
// an empty/omitted weekday mask means the same as all seven days — daily.
function weekdayKey(weekdays: ReadonlyArray<number> | undefined): string {
  const unique = [...new Set(weekdays ?? [])].toSorted((x, y) => x - y);
  if (unique.length === 0 || unique.length === 7) return "daily";
  return unique.join(",");
}

function sameSchedule(a: ScheduledTaskUpsertSchedule, b: ScheduledTaskUpsertSchedule): boolean {
  if (a.type === "interval") {
    return b.type === "interval" && a.everyMs === b.everyMs;
  }
  if (a.type === "webhook") {
    if (b.type !== "webhook") return false;
    // A typed secret is write-only, so entering one is always a change.
    const signatureKey = (signature: typeof a.signature) =>
      signature == null
        ? null
        : JSON.stringify([
            signature.header.toLowerCase(),
            signature.encoding,
            signature.prefix,
            signature.secret ?? null,
          ]);
    return (
      signatureKey(a.signature) === signatureKey(b.signature) &&
      (a.maxDeliveryAgeMinutes ?? null) === (b.maxDeliveryAgeMinutes ?? null)
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

// Compare against the opening draft so concurrent edits and round-trip conversions
// cannot manufacture dirty fields. Keep projectId as the live authorization scope.
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
  // The caller rejects an invalid draft schedule before saving; an opening
  // baseline that no longer parses counts as changed.
  const schedule = scheduleFromDraft(draft);
  const baselineSchedule = scheduleFromDraft(baseline);
  if (
    schedule !== null &&
    (baselineSchedule === null ||
      !sameSchedule(schedule, baselineSchedule) ||
      // Normalize legacy sub-minute intervals only while the live task still has one.
      (task.schedule.type === "interval" && task.schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS))
  ) {
    patch.schedule = schedule;
  }
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
  // Detach only when this patch moves the task, preserving a concurrent move and rebind.
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
