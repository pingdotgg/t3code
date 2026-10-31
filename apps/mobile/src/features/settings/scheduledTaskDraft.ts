import { isWebhookDedupeTemplate } from "@t3tools/contracts";
import type {
  ModelSelection,
  ServerConfig,
  ProjectId,
  RuntimeMode,
  ScheduledTask,
  ScheduledTaskUpsertSchedule,
  ScheduledTaskWebhookSignature,
} from "@t3tools/contracts";

import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import {
  parseMaxDeliveryAge,
  parseWebhookFilterDrafts,
  webhookFilterDrafts,
  webhookFilterDraftsChanged,
  type WebhookFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-webhook";
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
    resolveDefaultableModelSelection(config, configured, project?.id ?? null) ??
    resolveDefaultableModelSelection(config, settings.defaultModelSelection, project?.id ?? null);
  return resolveNewTaskModelSelection({
    draftSelection: null,
    projectDefaultSelection,
    stickySelection: null,
    modelOptions: buildModelOptions(
      config,
      projectDefaultSelection,
      undefined,
      project?.id ?? null,
    ),
  });
}

export type ScheduleDraft = {
  readonly mode: "fixed_time" | "interval" | "webhook";
  readonly timeOfDay: string;
  readonly weekdays: ReadonlyArray<number>;
  readonly intervalMinutes: string;
  readonly signature: ScheduledTaskWebhookSignature | null;
  readonly maxDeliveryAgeMinutes: string;
  readonly replayKey: string;
  readonly coalesceKey: string;
  readonly coalesceWindowSeconds: string;
  readonly filters: ReadonlyArray<WebhookFilterDraft>;
  /** The filter rows the form opened with. */
  readonly savedFilters: ReadonlyArray<WebhookFilterDraft>;
};

export const DEFAULT_SCHEDULE: ScheduleDraft = {
  mode: "fixed_time",
  timeOfDay: "09:00",
  weekdays: [1, 2, 3, 4, 5],
  intervalMinutes: "15",
  signature: null,
  maxDeliveryAgeMinutes: "",
  replayKey: "",
  coalesceKey: "",
  coalesceWindowSeconds: "",
  filters: [],
  savedFilters: [],
};

export function scheduleDraftForTask(task: Pick<ScheduledTask, "schedule">): ScheduleDraft {
  switch (task.schedule.type) {
    case "fixed_time":
      return {
        ...DEFAULT_SCHEDULE,
        timeOfDay: task.schedule.timeOfDay,
        weekdays: task.schedule.weekdays?.length
          ? [...new Set(task.schedule.weekdays)].sort((a, b) => a - b)
          : [0, 1, 2, 3, 4, 5, 6],
      };
    case "interval":
      return {
        ...DEFAULT_SCHEDULE,
        mode: "interval",
        intervalMinutes: String(Math.max(1, task.schedule.everyMs / 60_000)),
      };
    case "webhook":
      return {
        ...DEFAULT_SCHEDULE,
        mode: "webhook",
        signature: task.schedule.signature,
        replayKey: task.schedule.dedupe?.replayKey ?? "",
        coalesceKey: task.schedule.dedupe?.coalesceKey ?? "",
        coalesceWindowSeconds:
          task.schedule.dedupe?.coalesceWindowSeconds === undefined
            ? ""
            : String(task.schedule.dedupe.coalesceWindowSeconds),
        maxDeliveryAgeMinutes:
          task.schedule.maxDeliveryAgeMinutes == null
            ? ""
            : String(task.schedule.maxDeliveryAgeMinutes),
        filters: webhookFilterDrafts(task.schedule.filters),
        savedFilters: webhookFilterDrafts(task.schedule.filters),
      };
  }
}

export function parseIntervalMinutes(value: string): number {
  return Number(value.trim().replace(",", "."));
}

export function scheduleFromDraft(draft: ScheduleDraft): ScheduledTaskUpsertSchedule | null {
  if (draft.mode === "webhook") {
    const maxDeliveryAgeMinutes = parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes);
    if (maxDeliveryAgeMinutes === undefined) return null;
    const replayKey = draft.replayKey.trim();
    const coalesceKey = draft.coalesceKey.trim();
    if ([replayKey, coalesceKey].some((key) => key && !isWebhookDedupeTemplate(key))) return null;
    const coalesceWindowSeconds = draft.coalesceWindowSeconds?.trim()
      ? Number(draft.coalesceWindowSeconds)
      : undefined;
    if (
      coalesceWindowSeconds !== undefined &&
      (!Number.isInteger(coalesceWindowSeconds) ||
        coalesceWindowSeconds < 10 ||
        coalesceWindowSeconds > 3600)
    )
      return null;
    const parsedFilters = parseWebhookFilterDrafts(draft.filters);
    if (!("filters" in parsedFilters)) return null;
    // No secret is sent, so the server keeps the stored one.
    return {
      type: "webhook",
      signature:
        draft.signature === null
          ? null
          : {
              header: draft.signature.header,
              encoding: draft.signature.encoding,
              prefix: draft.signature.prefix,
            },
      maxDeliveryAgeMinutes,
      ...(replayKey || coalesceKey || coalesceWindowSeconds !== undefined
        ? {
            dedupe: {
              ...(replayKey ? { replayKey } : {}),
              ...(coalesceKey ? { coalesceKey } : {}),
              ...(coalesceWindowSeconds === undefined ? {} : { coalesceWindowSeconds }),
            },
          }
        : { dedupe: {} }),
      // Only edited filters are sent; the server keeps the stored ones otherwise.
      ...(webhookFilterDraftsChanged(draft.savedFilters, draft.filters)
        ? { filters: parsedFilters.filters }
        : {}),
    };
  }
  if (draft.mode === "interval") {
    const minutes = parseIntervalMinutes(draft.intervalMinutes);
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
    draft.schedule.maxDeliveryAgeMinutes,
    draft.schedule.replayKey,
    draft.schedule.coalesceKey,
    draft.schedule.coalesceWindowSeconds,
    draft.schedule.filters.map(({ path, op, value }) => [path, op, value]),
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
