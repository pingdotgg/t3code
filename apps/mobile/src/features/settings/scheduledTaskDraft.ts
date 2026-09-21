import type {
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ServerConfig,
  ProjectId,
  RuntimeMode,
  ScheduledTask,
  ScheduledTaskUpdateInput,
  ScheduledTaskUpsertSchedule,
} from "@t3tools/contracts";

import { DEFAULT_SERVER_SETTINGS, MIN_SCHEDULED_TASK_INTERVAL_MS } from "@t3tools/contracts";
import {
  resolveProjectSettings,
  type LegacyProjectSettingsFields,
} from "@t3tools/shared/projectSettings";
import {
  buildModelOptions,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
} from "../../lib/modelOptions";

export function scheduledTaskDefaultModel(
  config: ServerConfig | null,
  project: (LegacyProjectSettingsFields & { readonly id: ProjectId }) | null,
): ModelSelection | null {
  const settings = config?.settings ?? DEFAULT_SERVER_SETTINGS;
  const configured = resolveProjectSettings(settings, project?.id ?? null, project).settings
    .defaultModelSelection;
  const projectDefaultSelection =
    resolveDefaultableModelSelection(config, configured) ??
    resolveDefaultableModelSelection(config, settings.defaultModelSelection);
  return resolveNewTaskModelSelection({
    draftSelection: null,
    projectDefaultSelection,
    stickySelection: null,
    modelOptions: buildModelOptions(config, projectDefaultSelection),
  });
}

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

export function scheduleDraftForTask(task: Pick<ScheduledTask, "schedule">): ScheduleDraft {
  return task.schedule.type === "fixed_time"
    ? {
        ...DEFAULT_SCHEDULE,
        timeOfDay: task.schedule.timeOfDay,
        weekdays: task.schedule.weekdays?.length
          ? [...new Set(task.schedule.weekdays)].sort((a, b) => a - b)
          : [0, 1, 2, 3, 4, 5, 6],
      }
    : {
        ...DEFAULT_SCHEDULE,
        mode: "interval",
        intervalMinutes: String(Math.max(1, task.schedule.everyMs / 60_000)),
      };
}

export function scheduleFromDraft(draft: ScheduleDraft): ScheduledTaskUpsertSchedule | null {
  if (draft.mode === "interval") {
    const minutes = Number(draft.intervalMinutes);
    // Undo floating-point noise from displaying existing millisecond intervals as minutes.
    const everyMs = Math.round(minutes * 60_000);
    return minutes >= 1 && Number.isSafeInteger(everyMs) ? { type: "interval", everyMs } : null;
  }
  const weekdays = [...new Set(draft.weekdays)].sort((a, b) => a - b);
  if (
    !/^([01]?\d|2[0-3]):[0-5]\d$/.test(draft.timeOfDay) ||
    weekdays.length === 0 ||
    weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  ) {
    return null;
  }
  return {
    type: "fixed_time",
    timeOfDay: draft.timeOfDay,
    ...(weekdays.length === 7 ? {} : { weekdays }),
  };
}

type Workspace = "worktree" | "root" | "existing_worktree";
export type ScheduledTaskDraft = {
  readonly task: ScheduledTask | null;
  readonly title: string;
  readonly prompt: string;
  readonly projectId: ProjectId | null;
  readonly modelSelection: ModelSelection | null;
  readonly modelSelectionIsExplicit: boolean;
  readonly schedule: ScheduleDraft;
  readonly workspace: Workspace;
  readonly baseRef: string;
  readonly checkoutPath: string;
  readonly enabled: boolean;
  readonly startFromOrigin: boolean;
  readonly runtimeMode: RuntimeMode;
};

function draftSignature(draft: ScheduledTaskDraft): string {
  return JSON.stringify([
    draft.title,
    draft.prompt,
    draft.projectId,
    draft.modelSelection?.instanceId,
    draft.modelSelection?.model,
    [...(draft.modelSelection?.options ?? [])]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((option) => [option.id, option.value]),
    draft.schedule.mode,
    draft.schedule.timeOfDay,
    [...draft.schedule.weekdays].sort((a, b) => a - b),
    draft.schedule.intervalMinutes,
    draft.workspace,
    draft.baseRef,
    draft.checkoutPath,
    draft.enabled,
    draft.startFromOrigin,
    draft.runtimeMode,
  ]);
}

export function hasScheduledTaskDraftChanges(
  initial: ScheduledTaskDraft,
  current: ScheduledTaskDraft,
): boolean {
  return draftSignature(initial) !== draftSignature(current);
}

export function createDraft(
  projectId: ProjectId | null,
  modelSelection: ModelSelection | null,
): ScheduledTaskDraft {
  return {
    task: null,
    title: "",
    prompt: "",
    projectId,
    modelSelection,
    modelSelectionIsExplicit: false,
    schedule: DEFAULT_SCHEDULE,
    workspace: "worktree",
    baseRef: "main",
    checkoutPath: "",
    enabled: true,
    startFromOrigin: true,
    runtimeMode: "full-access",
  };
}

export function editDraft(task: ScheduledTask): ScheduledTaskDraft {
  return {
    task,
    title: task.title,
    prompt: task.prompt,
    projectId: task.projectId,
    modelSelection: task.modelSelection,
    modelSelectionIsExplicit: true,
    schedule: scheduleDraftForTask(task),
    workspace: task.workspaceStrategy.type,
    baseRef: task.workspaceStrategy.type === "worktree" ? task.workspaceStrategy.baseRef : "main",
    checkoutPath:
      task.workspaceStrategy.type === "existing_worktree"
        ? task.workspaceStrategy.worktreePath
        : "",
    enabled: task.enabled,
    startFromOrigin:
      task.workspaceStrategy.type === "worktree"
        ? (task.workspaceStrategy.startFromOrigin ?? false)
        : true,
    runtimeMode: task.runtimeMode,
  };
}

function sameSchedule(a: ScheduledTaskUpsertSchedule, b: ScheduledTaskUpsertSchedule): boolean {
  if (a.type === "interval") {
    return b.type === "interval" && a.everyMs === b.everyMs;
  }
  if (b.type !== "fixed_time") return false;
  const key = (weekdays: ReadonlyArray<number> | undefined) => {
    const unique = [...new Set(weekdays ?? [])].sort((x, y) => x - y);
    return unique.length === 0 || unique.length === 7 ? "daily" : unique.join(",");
  };
  return a.timeOfDay === b.timeOfDay && key(a.weekdays) === key(b.weekdays);
}

function sameModelSelection(a: ModelSelection | null, b: ModelSelection | null): boolean {
  if (a === null || b === null) return a === b;
  const key = (selection: ModelSelection) =>
    JSON.stringify([
      selection.instanceId,
      selection.model,
      [...(selection.options ?? [])]
        .sort((x, y) => x.id.localeCompare(y.id))
        .map((option) => [option.id, option.value]),
    ]);
  return key(a) === key(b);
}

function workspaceStrategyFromDraft(
  draft: ScheduledTaskDraft,
): OrchestrationV2ThreadLaunchWorkspaceStrategy {
  if (draft.workspace === "root") return { type: "root" };
  if (draft.workspace === "existing_worktree") {
    return { type: "existing_worktree", worktreePath: draft.checkoutPath.trim() };
  }
  return {
    type: "worktree",
    baseRef: draft.baseRef.trim() || "main",
    startFromOrigin: draft.startFromOrigin,
  };
}

/**
 * Dirty-field patch for an existing task, scoped to its live project. The
 * baseline is the task snapshot the editor opened with (`draft.task`), so a
 * concurrent commit landing mid-session is never read as a change the user
 * made — and `projectId` tracks the live row, so a save still targets the
 * task wherever it currently lives. Returns null when nothing changed.
 */
export function buildScheduledTaskUpdateInput(
  draft: ScheduledTaskDraft,
  liveTask: ScheduledTask,
): ScheduledTaskUpdateInput | null {
  const opening = draft.task;
  if (opening === null) return null;
  const baseline = editDraft(opening);
  const patch: {
    -readonly [
      K in Exclude<keyof ScheduledTaskUpdateInput, "id" | "projectId">
    ]?: ScheduledTaskUpdateInput[K];
  } = {};
  const title = draft.title.trim();
  if (title !== baseline.title.trim()) patch.title = title;
  const prompt = draft.prompt.trim();
  if (prompt !== baseline.prompt.trim()) patch.prompt = prompt;
  if (draft.enabled !== baseline.enabled) patch.enabled = draft.enabled;
  const schedule = scheduleFromDraft(draft.schedule);
  const baselineSchedule = scheduleFromDraft(baseline.schedule);
  if (
    schedule !== null &&
    baselineSchedule !== null &&
    (!sameSchedule(schedule, baselineSchedule) ||
      // scheduleDraftForTask clamps a legacy sub-minute interval to one
      // minute, so the baseline diff cannot see the normalization the
      // editor promises. Emit the normalized schedule while the live task
      // still carries it — a concurrent write to a valid interval clears
      // this condition instead of being overwritten.
      (liveTask.schedule.type === "interval" &&
        liveTask.schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS))
  ) {
    patch.schedule = schedule;
  }
  if (draft.runtimeMode !== baseline.runtimeMode) patch.runtimeMode = draft.runtimeMode;
  if (
    draft.modelSelection !== null &&
    !sameModelSelection(draft.modelSelection, baseline.modelSelection)
  ) {
    patch.modelSelection = draft.modelSelection;
  }
  const workspaceStrategy = workspaceStrategyFromDraft(draft);
  const baselineStrategy = workspaceStrategyFromDraft(baseline);
  if (JSON.stringify(workspaceStrategy) !== JSON.stringify(baselineStrategy)) {
    if (workspaceStrategy.type !== baselineStrategy.type) {
      patch.workspaceStrategy = workspaceStrategy;
    } else if (
      workspaceStrategy.type === "worktree" &&
      baselineStrategy.type === "worktree" &&
      liveTask.workspaceStrategy.type === "worktree"
    ) {
      // Send only the controls the user changed: the server merges the
      // sparse patch into the live strategy inside the update transaction,
      // so a concurrent edit to an untouched control — or to a field the
      // editor cannot express (`branch`) — survives on both sides.
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
      liveTask.workspaceStrategy.type === "existing_worktree"
    ) {
      patch.workspaceStrategyPatch = { worktreePath: workspaceStrategy.worktreePath };
    }
    // A live kind the draft no longer matches means a concurrent editor
    // switched it — drop the stale control edit rather than revert that.
  }
  if (draft.projectId !== null && draft.projectId !== baseline.projectId) {
    patch.nextProjectId = draft.projectId;
    // A binding cannot follow a real re-home — the thread stays in the old
    // project — so a patch that moves the task detaches it; a stale save
    // landing where the task already lives keeps a concurrent rebind.
    if (draft.projectId !== liveTask.projectId && liveTask.threadId !== null) {
      patch.threadId = null;
    }
  }
  if (Object.keys(patch).length === 0) return null;
  return { id: liveTask.id, projectId: liveTask.projectId, ...patch };
}
