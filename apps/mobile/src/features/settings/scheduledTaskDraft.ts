import { isWebhookDedupeTemplate, scheduledTaskThreadMode } from "@t3tools/contracts";
import type {
  EnvironmentId,
  McpGatewayProfile,
  ModelSelection,
  ProviderInteractionMode,
  ServerConfig,
  ServerProvider,
  ProjectId,
  RuntimeMode,
  ScheduledTask,
  ScheduledTaskThreadMode,
  ScheduledTaskUpsertSchedule,
  ScheduledTaskWebhookSignature,
  ThreadId,
} from "@t3tools/contracts";
import { resolveScheduledTaskProfileRouting } from "@t3tools/client-runtime/gateway";
import {
  cronToRepeatForm,
  localTimeZone,
  repeatFormToCron,
  type RepeatForm,
} from "@t3tools/client-runtime/scheduled-task-cron";

import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import {
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
  readonly mode: "fixed_time" | "once" | "interval" | "cron" | "webhook";
  readonly repeat: RepeatForm;
  /** IANA zone the cron expression runs in. */
  readonly timezone: string;
  readonly timeOfDay: string;
  /** ISO time for a one-time run. Empty until the user picks the "Once" mode. */
  readonly runAt: string;
  readonly weekdays: ReadonlyArray<number>;
  readonly intervalMinutes: string;
  readonly signature: ScheduledTaskWebhookSignature | null;
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
  runAt: "",
  weekdays: [1, 2, 3, 4, 5],
  intervalMinutes: "15",
  repeat: { preset: "daily", time: "09:00", weekday: 1, expression: "0 9 * * *" },
  timezone: localTimeZone(),
  signature: null,
  replayKey: "",
  coalesceKey: "",
  coalesceWindowSeconds: "",
  filters: [],
  savedFilters: [],
};

export function scheduleDraftForTask(task: Pick<ScheduledTask, "schedule">): ScheduleDraft {
  switch (task.schedule.type) {
    case "cron":
      return {
        ...DEFAULT_SCHEDULE,
        mode: "cron",
        repeat: cronToRepeatForm(task.schedule.expression),
        timezone: task.schedule.timezone,
      };
    case "fixed_time":
      return {
        ...DEFAULT_SCHEDULE,
        timeOfDay: task.schedule.timeOfDay,
        weekdays: task.schedule.weekdays?.length
          ? [...new Set(task.schedule.weekdays)].sort((a, b) => a - b)
          : [0, 1, 2, 3, 4, 5, 6],
      };
    case "once":
      return { ...DEFAULT_SCHEDULE, mode: "once", runAt: task.schedule.runAt };
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
        filters: webhookFilterDrafts(task.schedule.filters),
        savedFilters: webhookFilterDrafts(task.schedule.filters),
      };
  }
}

export function parseIntervalMinutes(value: string): number {
  return Number(value.trim().replace(",", "."));
}

export function scheduleFromDraft(draft: ScheduleDraft): ScheduledTaskUpsertSchedule | null {
  if (draft.mode === "cron") {
    const expression = repeatFormToCron(draft.repeat);
    const [, minute = ""] = draft.repeat.time.split(":");
    if (expression.split(/\s+/).length !== 5) return null;
    if (draft.repeat.preset === "hourly" && !/^[0-5]?\d$/.test(minute)) return null;
    return { type: "cron", expression, timezone: draft.timezone.trim() || localTimeZone() };
  }
  if (draft.mode === "webhook") {
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
  if (draft.mode === "once") {
    const runAt = new Date(draft.runAt);
    return Number.isNaN(runAt.getTime()) ? null : { type: "once", runAt: runAt.toISOString() };
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
  readonly threadId: ThreadId | null;
  /** Set for a task that runs as this agent in the agent's own thread. */
  readonly profileId: string | null;
  readonly modelSelection: ModelSelection | null;
  readonly modelSelectionIsExplicit: boolean;
  readonly schedule: ScheduleDraft;
  readonly threadMode: ScheduledTaskThreadMode;
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
    draft.threadId,
    draft.profileId,
    draft.modelSelection?.instanceId,
    draft.modelSelection?.model,
    [...(draft.modelSelection?.options ?? [])]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((option) => [option.id, option.value]),
    draft.schedule.mode,
    draft.schedule.timeOfDay,
    draft.schedule.runAt,
    [...draft.schedule.weekdays].sort((a, b) => a - b),
    draft.schedule.intervalMinutes,
    draft.schedule.repeat,
    draft.schedule.timezone,
    draft.schedule.replayKey,
    draft.schedule.coalesceKey,
    draft.schedule.coalesceWindowSeconds,
    draft.schedule.filters.map(({ path, op, value }) => [path, op, value]),
    draft.threadMode,
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

export function moveDraftToThread(
  draft: ScheduledTaskDraft,
  thread: { readonly id: ThreadId; readonly projectId: ProjectId },
): ScheduledTaskDraft {
  return {
    ...draft,
    threadId: thread.id,
    projectId: thread.projectId,
    profileId: null,
    threadMode: draft.threadMode === "new_thread" ? "continue" : draft.threadMode,
  };
}

/** Leaves the thread but keeps the mode. Matches MCP: new threads stay out of the shared checkout. */
export function unbindDraftFromThread(draft: ScheduledTaskDraft): ScheduledTaskDraft {
  if (draft.threadId === null) return draft;
  return {
    ...draft,
    threadId: null,
    ...(draft.workspace === "root"
      ? { workspace: "worktree" as const, startFromOrigin: true }
      : {}),
  };
}

export function changeDraftProject(
  draft: ScheduledTaskDraft,
  projectId: ProjectId,
): ScheduledTaskDraft {
  if (projectId === draft.projectId) return draft;
  return { ...unbindDraftFromThread(draft), projectId };
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
    threadId: null,
    profileId: null,
    modelSelection,
    modelSelectionIsExplicit: false,
    schedule: DEFAULT_SCHEDULE,
    threadMode: "new_thread",
    workspace: "worktree",
    baseRef: "",
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
    threadId: task.threadId,
    profileId: task.profileId ?? null,
    modelSelection: task.modelSelection,
    modelSelectionIsExplicit: true,
    schedule: scheduleDraftForTask(task),
    threadMode: scheduledTaskThreadMode(task),
    workspace: task.workspaceStrategy.type,
    baseRef: task.workspaceStrategy.type === "worktree" ? task.workspaceStrategy.baseRef : "",
    checkoutPath:
      task.workspaceStrategy.type === "existing_worktree"
        ? task.workspaceStrategy.worktreePath
        : "",
    // Saving restores an archived task, so it opens ready to run again.
    enabled: task.enabled || task.archivedAt != null,
    startFromOrigin:
      task.workspaceStrategy.type === "worktree"
        ? (task.workspaceStrategy.startFromOrigin ?? false)
        : true,
    runtimeMode: task.runtimeMode,
  };
}

/** Runs go to this agent's own thread, the one it already had when the agent is unchanged. */
export function moveDraftToAgent(draft: ScheduledTaskDraft, profileId: string): ScheduledTaskDraft {
  return {
    ...draft,
    profileId,
    threadId: draft.task?.profileId === profileId ? draft.task.threadId : null,
    threadMode: "continue",
  };
}

/** Leaves the agent and its thread; the caller picks the thread mode. */
export function moveDraftOffAgent(draft: ScheduledTaskDraft): ScheduledTaskDraft {
  return draft.profileId === null ? draft : { ...draft, profileId: null, threadId: null };
}

/** Agents that can run tasks on this environment: not read-only, and not scoped elsewhere. */
export function schedulableAgentProfiles(
  profiles: ReadonlyArray<McpGatewayProfile>,
  environmentId: EnvironmentId,
): ReadonlyArray<McpGatewayProfile> {
  return profiles.filter(
    (profile) =>
      profile.runtimeMode !== "read-only" &&
      (!profile.environmentIds?.length || profile.environmentIds.includes(environmentId)),
  );
}

/**
 * Where a save sends runs, and the model and modes they use. Agent tasks take them from the
 * agent, and existing ones keep theirs until the agent changes. `profileId: null` clears a
 * task's agent; omitted leaves a task that never had one alone.
 */
export function scheduledTaskDraftRouting(
  draft: ScheduledTaskDraft,
  context: {
    readonly profiles: ReadonlyArray<McpGatewayProfile>;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly offersThreadModes: boolean;
  },
):
  | string
  | {
      readonly profileId?: string | null;
      readonly threadId: ThreadId | null;
      readonly threadMode?: ScheduledTaskThreadMode;
      readonly modelSelection: ModelSelection;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    } {
  const task = draft.task;
  if (draft.profileId !== null) {
    const routing =
      task && task.profileId === draft.profileId
        ? {
            profileId: draft.profileId,
            modelSelection: task.modelSelection,
            runtimeMode: task.runtimeMode,
            interactionMode: task.interactionMode,
          }
        : resolveScheduledTaskProfileRouting(context.profiles, draft.profileId, context.providers);
    return typeof routing === "string" ? routing : { ...routing, threadId: draft.threadId };
  }
  if (draft.modelSelection === null) return "Choose a model.";
  const wasAgent = task?.profileId !== undefined;
  return {
    ...(wasAgent ? { profileId: null } : {}),
    threadId: draft.threadId,
    ...(context.offersThreadModes ? { threadMode: draft.threadMode } : {}),
    modelSelection: draft.modelSelection,
    runtimeMode: draft.runtimeMode,
    // An agent's interaction mode does not carry over to a plain thread.
    interactionMode: task && !wasAgent ? task.interactionMode : "default",
  };
}
