import { isListedThreadLineage, isWebhookDedupeTemplate } from "@t3tools/contracts";
import {
  EnvironmentId,
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  type ProjectId,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskSchedule,
  type ScheduledTaskThreadMode,
  type ScheduledTaskUpsertSchedule,
  scheduledTaskThreadMode,
  type ModelSelection,
  type RuntimeMode,
  type ProviderInteractionMode,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  parseMaxDeliveryAge,
  parseWebhookFilterDrafts,
  webhookFilterDrafts,
  webhookFilterDraftsChanged,
  type WebhookFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-webhook";
import { scheduleTimeZoneLabel } from "@t3tools/client-runtime/scheduled-task-time-zone";
import { msg } from "gt-react";

import {
  resolveProjectSettings,
  type LegacyProjectSettingsFields,
} from "@t3tools/shared/projectSettings";
import { getActiveLocale, m, type MessageResolver } from "../../i18n/messages";
import type { ProviderInstanceEntry } from "../../providerInstances";

import type { ResolvedSettingsScope } from "./settingsScope";

/** Abbreviated weekday name, 0 = Sunday. */
export function weekdayShortLabel(day: number, locale: string = getActiveLocale()): string {
  // 2024-01-07 was a Sunday.
  return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(2024, 0, 7 + day)),
  );
}

const ONCE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function scheduleLabel(
  schedule: ScheduledTaskSchedule,
  timeZone?: string,
  runAt?: string | null,
  resolve: MessageResolver = m,
  locale: string = getActiveLocale(),
): string {
  if (schedule.type === "webhook") return resolve(msg("On webhook"));
  if (schedule.type === "once") {
    return resolve(msg("Once, {time}", { time: ONCE_FORMATTER.format(new Date(schedule.runAt)) }));
  }
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    if (minutes >= 60 && minutes % 60 === 0) {
      const hours = minutes / 60;
      return resolve(
        msg("{hours, plural, one {Every hour} other {Every {hours} hours}}", { hours }),
      );
    }
    return Number.isInteger(minutes)
      ? resolve(msg("Every {minutes} min", { minutes }))
      : resolve(msg("Every {seconds} sec", { seconds: Math.round(schedule.everyMs / 1000) }));
  }
  const weekdays = schedule.weekdays ?? [];
  const time = schedule.timeOfDay;
  const zone = scheduleTimeZoneLabel(timeZone, runAt);
  if (weekdays.length === 0) {
    return zone === undefined
      ? resolve(msg("Daily at {time}", { time }))
      : resolve(msg("Daily at {time} {zone}", { time, zone }));
  }
  if (weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)) {
    return zone === undefined
      ? resolve(msg("Weekdays at {time}", { time }))
      : resolve(msg("Weekdays at {time} {zone}", { time, zone }));
  }
  const days = weekdays
    .map((day) => (day >= 0 && day <= 6 ? weekdayShortLabel(day, locale) : ""))
    .join(", ");
  return zone === undefined
    ? resolve(msg("{days} at {time}", { days, time }))
    : resolve(msg("{days} at {time} {zone}", { days, time, zone }));
}

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

export type ScheduleMode = "fixed" | "once" | "interval" | "webhook";
export type WorkspaceMode = "root" | "worktree" | "existing_worktree";

export interface DraftState {
  readonly editingId: string | null;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly scheduleMode: ScheduleMode;
  readonly intervalMinutes: string;
  readonly timeOfDay: string;
  /** Local date and time as a `datetime-local` input value, such as 2026-11-02T15:00. */
  readonly runAt: string;
  /** The stored ISO run time, sent back unchanged when the field was not edited. */
  readonly savedRunAt: string;
  readonly weekdays: ReadonlySet<number>;
  readonly projectId: string;
  readonly threadId: string;
  readonly threadMode: ScheduledTaskThreadMode;
  readonly workspaceMode: WorkspaceMode;
  readonly baseRef: string;
  readonly startFromOrigin: boolean;
  readonly existingWorktreePath: string;
  readonly modelKey: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /** Retain the source selection's provider options when the picker leaves instanceId:model unchanged. */
  readonly baseModelSelection: ModelSelection | null;
  readonly signatureEnabled: boolean;
  readonly signatureHeader: string;
  readonly signatureEncoding: "hex" | "base64";
  readonly signaturePrefix: string;
  /** Write-only: empty keeps the secret already stored on the server. */
  readonly signatureSecret: string;
  readonly maxDeliveryAgeMinutes: string;
  readonly replayKey: string;
  readonly coalesceKey: string;
  readonly coalesceWindowSeconds: string;
  readonly filters: ReadonlyArray<WebhookFilterDraft>;
  /** The filter rows the form opened with. */
  readonly savedFilters: ReadonlyArray<WebhookFilterDraft>;
}

export const WEBHOOK_SIGNATURE_DEFAULTS = {
  signatureHeader: "x-hub-signature-256",
  signatureEncoding: "hex",
  signaturePrefix: "sha256=",
} as const;

/** Formats a date as a `datetime-local` input value in the browser's time zone. */
export function toDateTimeLocalValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function scheduleDraftErrors(draft: DraftState, resolve: MessageResolver = m) {
  const invalidRunTime = (description: string) => [
    { title: resolve(msg("Invalid run time")), description },
  ];
  if (draft.scheduleMode === "once") {
    const runAt = new Date(draft.runAt);
    if (Number.isNaN(runAt.getTime())) return invalidRunTime(resolve(msg("Pick a date and time.")));
    // A time skipped by a daylight saving change parses to a different clock time.
    if (toDateTimeLocalValue(runAt) !== draft.runAt)
      return invalidRunTime(resolve(msg("That time does not exist in your time zone.")));
    return [];
  }
  if (draft.scheduleMode === "fixed" && !draft.timeOfDay)
    return invalidRunTime(resolve(msg("Pick a time.")));
  if (draft.scheduleMode !== "webhook") return [];
  if (parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes) === undefined)
    return [
      {
        title: resolve(msg("Invalid age limit")),
        description: resolve(
          msg("Enter whole minutes from 1 to {max}, or leave it blank.", {
            max: MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
          }),
        ),
      },
    ];
  const errors: Array<{ title: string; description: string }> = [];
  for (const [description, value] of [
    [msg("Duplicate request key must contain a valid request placeholder."), draft.replayKey],
    [msg("Coalesce key must contain a valid request placeholder."), draft.coalesceKey],
  ] as const) {
    if (value.trim() && !isWebhookDedupeTemplate(value.trim()))
      errors.push({
        title: resolve(msg("Invalid webhook settings")),
        description: resolve(description),
      });
  }
  const window = draft.coalesceWindowSeconds.trim();
  if (window && (!Number.isInteger(Number(window)) || Number(window) < 10 || Number(window) > 3600))
    errors.push({
      title: resolve(msg("Invalid webhook settings")),
      description: resolve(msg("Coalesce window must be whole seconds from 10 to 3600.")),
    });
  return errors;
}

const WEBHOOK_DELIVERY_LABELS: Record<string, string> = {
  dispatch_failed: msg("Run failed"),
  duplicate: msg("Duplicate", { $context: "webhook delivery outcome" }),
  coalesced: msg("Coalesced"),
  filtered: msg("Filtered", { $context: "webhook delivery outcome" }),
  rejected_signature: msg("Bad signature"),
  disabled: msg("Task paused"),
  rate_limited: msg("Rate limited"),
  expired: msg("Too old"),
};

export function webhookDeliveryLabel(
  delivery: {
    readonly outcome: string;
    readonly pendingWindow?: boolean | undefined;
  },
  resolve: MessageResolver = m,
) {
  if (delivery.outcome === "accepted") {
    return delivery.pendingWindow
      ? resolve(msg("Opened window"))
      : resolve(msg("Ran", { $context: "webhook delivery outcome" }));
  }
  const label = WEBHOOK_DELIVERY_LABELS[delivery.outcome];
  return label ? resolve(label) : delivery.outcome.replaceAll("_", " ");
}

export function scheduleFromDraft(draft: DraftState): ScheduledTaskUpsertSchedule | null {
  if (scheduleDraftErrors(draft).length > 0) return null;
  if (draft.scheduleMode === "once") {
    const saved = draft.savedRunAt ? new Date(draft.savedRunAt) : null;
    if (saved !== null && toDateTimeLocalValue(saved) === draft.runAt)
      return { type: "once", runAt: draft.savedRunAt };
    // A `datetime-local` value has no offset. In an hour that repeats when clocks go
    // back, keep the saved time's offset; otherwise Date reads it as local time.
    const withSavedOffset =
      saved === null
        ? null
        : new Date(Date.parse(`${draft.runAt}Z`) + saved.getTimezoneOffset() * 60_000);
    return {
      type: "once",
      runAt:
        withSavedOffset !== null && toDateTimeLocalValue(withSavedOffset) === draft.runAt
          ? withSavedOffset.toISOString()
          : new Date(draft.runAt).toISOString(),
    };
  }
  if (draft.scheduleMode === "webhook") {
    const maxDeliveryAgeMinutes = parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes);
    const replayKey = draft.replayKey.trim();
    const coalesceKey = draft.coalesceKey.trim();
    const coalesceWindowSeconds = draft.coalesceWindowSeconds.trim()
      ? Number(draft.coalesceWindowSeconds)
      : undefined;
    if (maxDeliveryAgeMinutes === undefined) return null;
    const parsedFilters = parseWebhookFilterDrafts(draft.filters);
    if (!("filters" in parsedFilters)) return null;
    const secret = draft.signatureSecret.trim();
    return {
      type: "webhook",
      signature: draft.signatureEnabled
        ? {
            header: draft.signatureHeader.trim(),
            encoding: draft.signatureEncoding,
            prefix: draft.signaturePrefix,
            ...(secret ? { secret } : {}),
          }
        : null,
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
  if (draft.scheduleMode === "interval") {
    const everyMs = Math.round(Number(draft.intervalMinutes) * 60_000);
    return { type: "interval", everyMs };
  }
  const selectedEveryDay = draft.weekdays.size === 0 || draft.weekdays.size === 7;
  return {
    type: "fixed_time",
    timeOfDay: draft.timeOfDay,
    ...(selectedEveryDay ? {} : { weekdays: [...draft.weekdays].toSorted() }),
  };
}

export function taskToDraft(task: ScheduledTask): DraftState {
  const schedule = task.schedule;
  const filters = webhookFilterDrafts(schedule.type === "webhook" ? schedule.filters : undefined);
  const weekdays =
    schedule.type === "fixed_time" && schedule.weekdays && schedule.weekdays.length > 0
      ? new Set(schedule.weekdays)
      : new Set([0, 1, 2, 3, 4, 5, 6]);
  return {
    editingId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    scheduleMode: schedule.type === "fixed_time" ? "fixed" : schedule.type,
    intervalMinutes:
      schedule.type === "interval" ? String(Math.max(1, schedule.everyMs / 60_000)) : "15",
    // A time input shows nothing for an unpadded hour such as 9:05, which agents may save.
    timeOfDay: schedule.type === "fixed_time" ? schedule.timeOfDay.padStart(5, "0") : "09:00",
    runAt: schedule.type === "once" ? toDateTimeLocalValue(new Date(schedule.runAt)) : "",
    savedRunAt: schedule.type === "once" ? schedule.runAt : "",
    weekdays,
    projectId: task.projectId,
    threadId: task.threadId ?? "",
    threadMode: scheduledTaskThreadMode(task),
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
    ...(schedule.type === "webhook" && schedule.signature !== null
      ? {
          signatureEnabled: true,
          signatureHeader: schedule.signature.header,
          signatureEncoding: schedule.signature.encoding,
          signaturePrefix: schedule.signature.prefix,
        }
      : { signatureEnabled: false, ...WEBHOOK_SIGNATURE_DEFAULTS }),
    signatureSecret: "",
    replayKey: schedule.type === "webhook" ? (schedule.dedupe?.replayKey ?? "") : "",
    coalesceKey: schedule.type === "webhook" ? (schedule.dedupe?.coalesceKey ?? "") : "",
    coalesceWindowSeconds:
      schedule.type === "webhook" && schedule.dedupe?.coalesceWindowSeconds !== undefined
        ? String(schedule.dedupe.coalesceWindowSeconds)
        : "",
    maxDeliveryAgeMinutes:
      schedule.type === "webhook" && schedule.maxDeliveryAgeMinutes != null
        ? String(schedule.maxDeliveryAgeMinutes)
        : "",
    filters,
    savedFilters: filters,
  };
}

export function moveDraftToThread(
  draft: DraftState,
  thread: { readonly id: ThreadId; readonly projectId: ProjectId },
): DraftState {
  return {
    ...draft,
    threadId: thread.id,
    projectId: thread.projectId,
    threadMode: draft.threadMode === "new_thread" ? "continue" : draft.threadMode,
  };
}

/** Leaves the thread but keeps the mode. Matches MCP: new threads stay out of the shared checkout. */
export function unbindDraftFromThread(draft: DraftState): DraftState {
  if (!draft.threadId) return draft;
  return {
    ...draft,
    threadId: "",
    ...(draft.workspaceMode === "root"
      ? { workspaceMode: "worktree" as const, startFromOrigin: true }
      : {}),
  };
}

export function changeDraftProject(draft: DraftState, projectId: string): DraftState {
  if (projectId === draft.projectId) return draft;
  return { ...unbindDraftFromThread(draft), projectId };
}

/** Threads a task can move to. The current one is left out; the picker always shows it. */
export function scheduledTaskDestinationThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  target: {
    readonly environmentId: EnvironmentId;
    readonly projectId: string;
    readonly currentThreadId: ThreadId | null;
    readonly query: string;
  },
): ReadonlyArray<EnvironmentThreadShell> {
  const search = target.query.trim().toLocaleLowerCase();
  return threads
    .filter(
      (thread) =>
        thread.environmentId === target.environmentId &&
        thread.projectId === target.projectId &&
        thread.id !== target.currentThreadId &&
        thread.archivedAt === null &&
        isListedThreadLineage(thread.lineage) &&
        thread.title.toLocaleLowerCase().includes(search),
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

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

/**
 * A new task's project: a pinned open project, then any open one. An archived
 * project only when Settings is scoped to it, so that scope can still save.
 */
export function defaultScheduledTaskProjectId<
  TProject extends {
    readonly id: ProjectId;
    readonly pinnedAt?: string | null | undefined;
    readonly archivedAt?: string | null | undefined;
  },
>(scopedProjects: ReadonlyArray<TProject>, scope: ResolvedSettingsScope): ProjectId | "" {
  const open = scopedProjects.filter((project) => project.archivedAt == null);
  const scopedToProject = scope.kind === "project" || scope.kind === "checkout";
  return (
    (
      open.find((project) => project.pinnedAt != null) ??
      open[0] ??
      (scopedToProject ? scopedProjects[0] : undefined)
    )?.id ?? ""
  );
}
