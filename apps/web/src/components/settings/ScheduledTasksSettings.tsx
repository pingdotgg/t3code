import { useAtomValue } from "@effect/atom-react";
import { createTranslator, type MessageKey, type TranslateFn } from "@t3tools/client-runtime/i18n";
import { getUiLocale, useT } from "../../hooks/useI18n";
import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import { AsyncResult } from "effect/reactivity";
import {
  ChevronDownIcon,
  Clock3Icon,
  CopyIcon,
  InboxIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskSchedule,
  ScheduledTaskThreadMode,
  ScheduledTaskUpsertInput,
  ScheduledTaskWebhookDeliverySummary,
  ThreadId,
} from "@t3tools/contracts";
import {
  DEFAULT_WEBHOOK_PROMPT,
  emptyWebhookFilterDraft,
  parseWebhookFilterDrafts,
  removeWebhookFilterDraft,
  WEBHOOK_FILTER_OPS,
  type WebhookFilterDraft,
} from "@t3tools/client-runtime/scheduled-task-webhook";
import {
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  MAX_WEBHOOK_FILTERS,
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ProviderInstanceId,
  resolveEnvironmentMachineKind,
  scheduledTaskThreadMode,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { formatRelativeTime } from "../../timestampFormat";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { usePrimaryCloudLinkState } from "../../cloud/cloudLinkState";
import { requestConfirmDialog } from "../../confirmDialog";
import { webhookAddress } from "@t3tools/client-runtime/webhook-address";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNowMinute } from "../../hooks/useNowMinute";
import {
  useEnvironment,
  useEnvironmentHttpBaseUrl,
  type EnvironmentPresentation,
} from "../../state/environments";
import {
  useProjects,
  useQuietThreadShell,
  useThreadShell,
  useVisibleThreadShells,
} from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { useThreadSearch } from "../../state/queries";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { threadFamilies } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorktreeBaseBranchPicker } from "../WorktreeBaseBranchPicker";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ConnectionStatusDot, connectionPhaseDotClassName } from "../ConnectionStatusDot";
import {
  AuthOrchestrationOperateScope,
  clampManagedRuntimeMode,
  managedCapabilityDenial,
} from "@t3tools/contracts";
import { resolvePastedPath } from "@t3tools/shared/path";
import { useManagedPolicy } from "~/state/managedPolicy";
import { ManagedNotice } from "../ManagedPolicy";
import { readEnvironmentScope } from "~/state/session";
import { useSettingsScope } from "./SettingsScopeContext";
import { EnvironmentRow, useEnvironmentTransportLabel } from "./EnvironmentRow";
import { SettingsGroup } from "./SettingsGroup";
import { settingsScopeEnvironmentLabel, settingsScopeEnvironmentLabels } from "./settingsScopeAxis";
import {
  WEBHOOK_SIGNATURE_DEFAULTS,
  changeDraftProject,
  moveDraftToThread,
  scheduleDraftErrors,
  scheduledTaskDestinationThreads,
  toDateTimeLocalValue,
  webhookDeliveryLabel,
  defaultScheduledTaskProjectId,
  matchesScheduledTaskScope,
  scheduleFromDraft,
  scheduledTaskDefaultModel,
  taskToDraft,
  unbindDraftFromThread,
  type DraftState,
  type ScheduleMode,
  type WorkspaceMode,
} from "./scheduledTasksSettings.logic";
import { Label } from "../ui/label";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "../ui/menu";
import { ToggleGroup, Toggle } from "../ui/toggle-group";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from "../ui/empty";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
} from "./settingsLayout";

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_LABELS = [
  "settings.code.tasks.daySun",
  "settings.code.tasks.dayMon",
  "settings.code.tasks.dayTue",
  "settings.code.tasks.dayWed",
  "settings.code.tasks.dayThu",
  "settings.code.tasks.dayFri",
  "settings.code.tasks.daySat",
] as const satisfies ReadonlyArray<MessageKey>;
const WEEKDAY_SHORT = [
  "settings.code.tasks.daySunShort",
  "settings.code.tasks.dayMonShort",
  "settings.code.tasks.dayTueShort",
  "settings.code.tasks.dayWedShort",
  "settings.code.tasks.dayThuShort",
  "settings.code.tasks.dayFriShort",
  "settings.code.tasks.daySatShort",
] as const satisfies ReadonlyArray<MessageKey>;

// Thread ids are trimmed, so the leading space keeps this from matching one.
const NEW_THREAD_DESTINATION = " new-thread";

const WORKSPACE_MODE_LABELS: Record<WorkspaceMode, MessageKey> = {
  worktree: "settings.code.tasks.workspaceWorktree",
  root: "settings.code.tasks.workspaceRoot",
  existing_worktree: "settings.code.tasks.workspaceExisting",
};

const LAST_RUN_STATUS_LABELS: Partial<Record<ScheduledTask["lastRunStatus"], MessageKey>> = {
  failed: "settings.code.tasks.statusFailed",
  succeeded: "settings.code.tasks.statusSucceeded",
  running: "settings.code.tasks.statusRunning",
};

const EMPTY_DRAFT: DraftState = {
  editingId: null,
  title: "",
  prompt: "",
  enabled: true,
  scheduleMode: "fixed",
  intervalMinutes: "15",
  timeOfDay: "09:00",
  runAt: "",
  savedRunAt: "",
  weekdays: new Set([1, 2, 3, 4, 5]),
  projectId: "",
  threadId: "",
  threadMode: "new_thread",
  workspaceMode: "worktree",
  baseRef: "main",
  startFromOrigin: true,
  existingWorktreePath: "",
  modelKey: "",
  runtimeMode: "full-access",
  interactionMode: "default",
  baseModelSelection: null,
  signatureEnabled: false,
  ...WEBHOOK_SIGNATURE_DEFAULTS,
  signatureSecret: "",
  maxDeliveryAgeMinutes: "",
  replayKey: "",
  coalesceKey: "",
  coalesceWindowSeconds: "",
  filters: [],
  savedFilters: [],
};

function WebhookFiltersField({
  filters,
  onChange,
}: {
  filters: ReadonlyArray<WebhookFilterDraft>;
  onChange: (filters: ReadonlyArray<WebhookFilterDraft>) => void;
}) {
  const t = useT();
  const update = (index: number, patch: Partial<WebhookFilterDraft>) =>
    onChange(filters.map((filter, at) => (at === index ? { ...filter, ...patch } : filter)));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <Label>{t("settings.code.tasks.filters")}</Label>
          <p className="text-sm text-muted-foreground">
            {t("settings.code.tasks.filtersDescription")}
          </p>
        </div>
        <Button
          className="shrink-0"
          variant="outline"
          size="sm"
          disabled={filters.length >= MAX_WEBHOOK_FILTERS}
          onClick={() => onChange([...filters, emptyWebhookFilterDraft()])}
        >
          <PlusIcon />
          {t("settings.code.tasks.addFilter")}
        </Button>
      </div>
      {filters.map((filter, index) => (
        // Always stacked: the dialog stays narrow on wide windows, so a single line
        // would cut off typical paths and values. The grid wrappers size each control
        // without restyling it; a grid item stretches to its minmax(0, 1fr) track.
        <div key={filter.id} className="space-y-2 pt-1">
          <div className="flex items-center gap-2">
            <div className="grid min-w-0 flex-1 grid-cols-1">
              <Input
                aria-label={t("settings.code.tasks.filterPath", { n: index + 1 })}
                placeholder="body.action"
                value={filter.path}
                onChange={(event) => update(index, { path: event.target.value })}
              />
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("settings.code.tasks.removeFilter", { n: index + 1 })}
              onClick={() => onChange(removeWebhookFilterDraft(filters, filter.id))}
            >
              <Trash2Icon />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={filter.op}
              onValueChange={(op) => {
                const known = WEBHOOK_FILTER_OPS.find((option) => option.op === op);
                if (known) update(index, { op: known.op });
              }}
            >
              <div className="grid w-44 shrink-0 grid-cols-1">
                <SelectTrigger
                  size="sm"
                  aria-label={t("settings.code.tasks.filterTest", { n: index + 1 })}
                >
                  <SelectValue>
                    {WEBHOOK_FILTER_OPS.find((option) => option.op === filter.op)?.label}
                  </SelectValue>
                </SelectTrigger>
              </div>
              <SelectPopup>
                {WEBHOOK_FILTER_OPS.map((option) => (
                  <SelectItem key={option.op} value={option.op}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {filter.op === "exists" ? null : (
              <div className="grid min-w-0 flex-1 grid-cols-1">
                <Input
                  aria-label={t("settings.code.tasks.filterValue", { n: index + 1 })}
                  placeholder={filter.op === "in" ? "opened, reopened" : "opened"}
                  value={filter.value}
                  onChange={(event) => update(index, { value: event.target.value })}
                />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-baseline justify-between" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint ? (
          <span className="font-normal text-2xs text-muted-foreground/80">{hint}</span>
        ) : null}
      </Label>
      {children}
    </div>
  );
}

function splitModelKey(value: string): ModelSelection | null {
  const index = value.indexOf(":");
  if (index <= 0 || index === value.length - 1) return null;
  return {
    instanceId: ProviderInstanceId.make(value.slice(0, index)),
    model: value.slice(index + 1),
  };
}

const ONCE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function scheduleLabel(
  schedule: ScheduledTaskSchedule,
  t: TranslateFn = createTranslator(getUiLocale()),
): string {
  if (schedule.type === "webhook") return t("settings.code.tasks.onWebhook");
  if (schedule.type === "once") {
    return t("settings.code.tasks.onceAt", {
      date: ONCE_FORMATTER.format(new Date(schedule.runAt)),
    });
  }
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    return Number.isInteger(minutes)
      ? t("settings.code.tasks.everyMinutes", { n: minutes })
      : t("settings.code.tasks.everySeconds", { n: Math.round(schedule.everyMs / 1000) });
  }
  const weekdays = schedule.weekdays ?? [];
  const days =
    weekdays.length === 0
      ? t("settings.code.tasks.daily")
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? t("settings.code.tasks.weekdays")
        : weekdays
            .map((day) => t(WEEKDAY_LABELS[day]!))
            .join(t("settings.code.tasks.listSeparator"));
  return t("settings.code.tasks.daysAt", { days, time: schedule.timeOfDay });
}

/** formatRelativeTime handles only the past; upcoming runs need future labels. */
function relativeLabel(t: TranslateFn, value: string | null, nowMs: number): string {
  if (!value) return t("settings.code.tasks.notScheduled");
  const diffMs = new Date(value).getTime() - nowMs;
  if (diffMs <= 0) {
    const relative = formatRelativeTime(value, nowMs);
    if (!relative) return t("settings.code.tasks.notScheduled");
    return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
  }
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 2) return t("settings.code.tasks.inUnderMinute");
  if (minutes < 60) return t("settings.code.tasks.inMinutes", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("settings.code.tasks.inHours", { n: hours });
  return t("settings.code.tasks.inDays", { n: Math.round(hours / 24) });
}

// Use the label's minute tick because the compiler caches render-time Date.now() on the timestamp.
export function ScheduledRelativeLabel(props: { value: string | null }) {
  const t = useT();
  const nowMinute = useNowMinute();
  return relativeLabel(t, props.value, Date.parse(`${nowMinute}:00.000Z`));
}

function deliveryOutcomeVariant(outcome: string) {
  if (outcome === "accepted") return "success";
  if (
    outcome === "duplicate" ||
    outcome === "coalesced" ||
    outcome === "disabled" ||
    outcome === "rate_limited" ||
    outcome === "expired"
  ) {
    return "warning";
  }
  if (outcome === "dispatch_failed" || outcome === "rejected_signature") return "error";
  return "outline";
}

function statusVariant(status: ScheduledTask["lastRunStatus"]) {
  if (status === "failed") return "error";
  if (status === "succeeded") return "success";
  if (status === "running") return "info";
  return "outline";
}

export function ScheduledTasksSettings(target: {
  readonly environmentId?: EnvironmentId;
  readonly taskId?: ScheduledTaskId | undefined;
}) {
  const t = useT();
  const { scope, environments, connectedEnvironments, environment } = useSettingsScope();
  const [editor, setEditor] = useState<{
    environmentId: EnvironmentId;
    task: ScheduledTask | null;
  } | null>(null);
  const openForEdit = (environmentId: EnvironmentId, task: ScheduledTask) => {
    setEditor({ environmentId, task });
  };
  const defaultEnvironment = environment ?? connectedEnvironments[0];
  const linkedEnvironmentId = target.environmentId ?? defaultEnvironment?.environmentId;
  const linkedEnvironmentConnected = environments.some(
    (entry) =>
      entry.environmentId === linkedEnvironmentId &&
      entry.connection.phase === "connected" &&
      entry.serverConfig !== null,
  );
  const linkedTasksQuery = useEnvironmentQuery(
    target.taskId !== undefined && linkedEnvironmentId !== undefined && linkedEnvironmentConnected
      ? serverEnvironment.scheduledTasksLive({ environmentId: linkedEnvironmentId, input: {} })
      : null,
  );
  const linkedTask = linkedTasksQuery.data?.tasks.find(
    (task) =>
      task.id === target.taskId &&
      linkedEnvironmentId !== undefined &&
      matchesScheduledTaskScope(scope, linkedEnvironmentId, task.projectId),
  );
  // A `taskId` link opens its editor once, the first time the task loads. The editor then owns
  // the session until close, so a disconnect that disables the query cannot drop unsaved edits.
  // An editor the user already opened wins: a late-loading link must not replace its draft.
  const [openedLinkTaskId, setOpenedLinkTaskId] = useState<ScheduledTaskId | undefined>();
  if (target.taskId === undefined && openedLinkTaskId !== undefined) {
    setOpenedLinkTaskId(undefined);
  }
  if (linkedTask && linkedEnvironmentId !== undefined && openedLinkTaskId !== target.taskId) {
    setOpenedLinkTaskId(target.taskId);
    if (editor === null) setEditor({ environmentId: linkedEnvironmentId, task: linkedTask });
  }
  const navigate = useNavigate({ from: "/settings/scheduled-tasks" });
  const closeEditor = () => {
    setEditor(null);
    if (target.taskId === undefined) return;
    void navigate({
      to: "/settings/scheduled-tasks",
      search: ({ taskId: _closed, ...rest }) => rest,
      replace: true,
    });
  };
  const createPermissions = useAtomValue(
    scheduledTaskCreatePermissionsAtom(
      environmentIdsKey(connectedEnvironments.map((entry) => entry.environmentId)),
    ),
  );
  const permittedEnvironments = connectedEnvironments.filter(
    (_entry, index) => createPermissions[index],
  );
  const creationEnvironment =
    permittedEnvironments.find(
      (entry) => entry.environmentId === defaultEnvironment?.environmentId,
    ) ?? permittedEnvironments[0];
  return (
    <SettingsPageContainer>
      <SettingsSection
        title={t("settings.code.tasks.title")}
        variant="plain"
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!creationEnvironment}
            onClick={() =>
              creationEnvironment &&
              setEditor({ environmentId: creationEnvironment.environmentId, task: null })
            }
          >
            <PlusIcon className="size-3" />
            {t("settings.code.tasks.newTask")}
          </Button>
        }
      >
        {scope.kind === "unavailable" ? (
          <SettingsSection title={t("settings.code.tasks.unavailableSelection")}>
            <SettingsRow title={scope.message} />
          </SettingsSection>
        ) : environments.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Clock3Icon />
              </EmptyMedia>
              <EmptyTitle>{t("settings.code.tasks.noEnvironments")}</EmptyTitle>
              <EmptyDescription>{t("settings.code.tasks.noEnvironmentsHint")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : environments.length > 1 ? (
          <ScheduledTaskEnvironmentList
            environmentId={linkedEnvironmentId}
            taskId={target.taskId}
            onEdit={openForEdit}
          />
        ) : (
          <div className="space-y-8">
            {environments.map((entry) => (
              <ScheduledTaskEnvironmentSection
                key={entry.environmentId}
                environment={entry}
                taskId={linkedEnvironmentId === entry.environmentId ? target.taskId : undefined}
                onEdit={openForEdit}
              />
            ))}
          </div>
        )}
      </SettingsSection>
      {editor ? (
        <ScheduledTaskEditorDialog
          key={`${editor.environmentId}:${editor.task?.id ?? "new"}`}
          initialEnvironmentId={editor.environmentId}
          task={editor.task}
          onClose={closeEditor}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

const scheduledTaskCreatePermissionsAtom = environmentAtomList(
  "web-scheduled-task-create-permissions",
  serverEnvironment.upsertScheduledTask.permissionAtom,
);

const scheduledTasksListAtom = environmentAtomList("web-scheduled-tasks-list", (environmentId) =>
  serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
);

function ScheduledTaskEnvironmentList({
  environmentId,
  taskId,
  onEdit,
}: {
  readonly environmentId: EnvironmentId | undefined;
  readonly taskId: ScheduledTaskId | undefined;
  readonly onEdit: (environmentId: EnvironmentId, task: ScheduledTask) => void;
}) {
  const t = useT();
  const { scope, environments } = useSettingsScope();
  const connectedIds = environments.flatMap((environment) =>
    environment.connection.phase === "connected" && environment.serverConfig !== null
      ? [environment.environmentId]
      : [],
  );
  const queries = useAtomValue(scheduledTasksListAtom(environmentIdsKey(connectedIds)));
  const states = environments.map((environment) => {
    const index = connectedIds.indexOf(environment.environmentId);
    const query = index < 0 ? null : queries[index]!;
    const data = query === null ? null : AsyncResult.getOrElse(query, () => null);
    return {
      environment,
      connected: index >= 0,
      tasks: data?.tasks.filter((task) =>
        matchesScheduledTaskScope(scope, environment.environmentId, task.projectId),
      ),
      error: query?._tag === "Failure" ? formatEnvironmentQueryError(query.cause) : null,
    };
  });
  const linkedState = states.find((state) => state.environment.environmentId === environmentId);
  const linkedTask = linkedState?.tasks?.find((task) => task.id === taskId);

  const loaded = states.filter((state) => state.connected && state.error === null && state.tasks);
  const populated = loaded.filter((state) => state.tasks && state.tasks.length > 0);
  const summaries: Record<
    | "settings.code.tasks.sumNotConnected"
    | "settings.code.tasks.sumLoading"
    | "settings.code.tasks.sumLoadFailed"
    | "settings.code.tasks.sumNoTasks",
    string[]
  > = {
    "settings.code.tasks.sumNotConnected": [],
    "settings.code.tasks.sumLoading": [],
    "settings.code.tasks.sumLoadFailed": [],
    "settings.code.tasks.sumNoTasks": [],
  };
  for (const { environment, connected, tasks, error } of states) {
    const label = settingsScopeEnvironmentLabel(environment, environments);
    if (!connected) {
      summaries["settings.code.tasks.sumNotConnected"]!.push(
        `${label} (${connectionStatusTitle(environment.connection)})`,
      );
    } else if (error !== null) {
      summaries["settings.code.tasks.sumLoadFailed"]!.push(`${label}: ${error}`);
    } else if (!tasks) {
      summaries["settings.code.tasks.sumLoading"]!.push(label);
    } else if (tasks.length === 0 && populated.length > 0) {
      summaries["settings.code.tasks.sumNoTasks"]!.push(label);
    }
  }

  return (
    <SettingsGroup>
      {populated.map(({ environment, tasks }) => {
        const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
        return (
          <div key={environment.environmentId} className="divide-y divide-border/50">
            <EnvironmentRow
              kind={resolveEnvironmentMachineKind(environment.serverConfig)}
              label={primary}
              subtitle={
                <ScheduledTaskEnvironmentSubtitle environment={environment} secondary={secondary} />
              }
            >
              <ConnectionStatusDot
                dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
                tooltipText={connectionStatusTitle(environment.connection)}
              />
              <span className="text-xs text-muted-foreground">
                {connectionStatusTitle(environment.connection)}
              </span>
            </EnvironmentRow>
            {tasks?.map((task) => (
              <ScheduledTaskRow
                key={task.id}
                environmentId={environment.environmentId}
                task={task}
                onEdit={() => onEdit(environment.environmentId, task)}
              />
            ))}
          </div>
        );
      })}
      {taskId && linkedState?.tasks && linkedState.error === null && !linkedTask ? (
        <SettingsRow
          title={t("settings.code.tasks.taskUnavailable")}
          description={t("settings.code.tasks.taskUnavailableHint")}
          role="status"
        />
      ) : null}
      {populated.length === 0 && loaded.length > 0 ? (
        <SettingsRow
          title={t("settings.code.tasks.noTasks")}
          description={t("settings.code.tasks.noTasksHint")}
        />
      ) : null}
      {Object.entries(summaries).map(([label, entries]) => {
        if (entries.length === 0) return null;
        const summary = `${t(label as keyof typeof summaries)} ${entries.join(", ")}`;
        return (
          <Tooltip key={label}>
            <TooltipTrigger
              render={
                <p
                  className="truncate px-3 py-2.5 text-xs text-muted-foreground sm:px-4"
                  role="status"
                />
              }
            >
              {summary}
            </TooltipTrigger>
            <TooltipPopup>{summary}</TooltipPopup>
          </Tooltip>
        );
      })}
    </SettingsGroup>
  );
}

function ScheduledTaskEnvironmentSubtitle({
  environment,
  secondary,
}: {
  readonly environment: EnvironmentPresentation;
  readonly secondary: string;
}) {
  const transport = useEnvironmentTransportLabel(environment);
  return (
    <>
      {secondary && secondary !== transport ? (
        <span className="block truncate">{secondary}</span>
      ) : null}
      <span className="block truncate">{transport}</span>
    </>
  );
}

function ScheduledTaskEnvironmentSection({
  environment,
  taskId,
  onEdit,
}: {
  readonly environment: EnvironmentPresentation;
  readonly taskId?: ScheduledTaskId | undefined;
  readonly onEdit: (environmentId: EnvironmentId, task: ScheduledTask) => void;
}) {
  const t = useT();
  const { scope } = useSettingsScope();
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  const tasksQuery = useEnvironmentQuery(
    connected
      ? serverEnvironment.scheduledTasksLive({
          environmentId: environment.environmentId,
          input: {},
        })
      : null,
  );
  const tasks = tasksQuery.data?.tasks.filter((task) =>
    matchesScheduledTaskScope(scope, environment.environmentId, task.projectId),
  );
  const linkedTask = tasks?.find((task) => task.id === taskId);
  return (
    <SettingsSection
      title={environment.label}
      hideTitle
      icon={
        <EnvironmentMachineIcon
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          className="size-3.5"
        />
      }
    >
      {!connected ? (
        <SettingsRow
          title={t("settings.code.tasks.envDisconnected")}
          description={t("settings.code.tasks.envReconnect", { name: environment.label })}
        />
      ) : tasksQuery.error ? (
        <SettingsRow title={t("settings.code.tasks.loadFailed")} description={tasksQuery.error} />
      ) : !tasks ? (
        <SettingsRow title={t("settings.code.tasks.loading")} role="status" />
      ) : (
        <>
          {taskId && !linkedTask ? (
            <SettingsRow
              title={t("settings.code.tasks.taskUnavailable")}
              description={t("settings.code.tasks.taskUnavailableHint")}
              role="status"
            />
          ) : null}
          {tasks.length === 0 ? (
            <SettingsRow
              title={t("settings.code.tasks.noTasks")}
              description={t("settings.code.tasks.noTasksHint")}
            />
          ) : (
            tasks.map((task) => (
              <ScheduledTaskRow
                key={task.id}
                environmentId={environment.environmentId}
                task={task}
                onEdit={() => onEdit(environment.environmentId, task)}
              />
            ))
          )}
        </>
      )}
    </SettingsSection>
  );
}

function ScheduledTaskRow({
  environmentId,
  task,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly onEdit: () => void;
}) {
  const t = useT();
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const [deliveriesOpen, setDeliveriesOpen] = useState(false);
  const isWebhook = task.schedule.type === "webhook";
  const toggle = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "scheduled task enabled",
  });
  const run = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run now",
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "scheduled task delete",
  });
  const act = async (action: "toggle" | "run" | "delete") => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    setBusy(true);
    const result =
      action === "toggle"
        ? await toggle({ environmentId, input: { id: task.id, enabled: !task.enabled } })
        : action === "run"
          ? await run({ environmentId, input: { id: task.id } })
          : await remove({ environmentId, input: { id: task.id } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("settings.code.tasks.updateFailed"),
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  return (
    <SettingsRow
      title={task.title}
      description={<span className="line-clamp-2">{task.prompt}</span>}
      status={
        <div className="flex flex-wrap items-center gap-2">
          <span>
            {scheduleLabel(task.schedule)} ·{" "}
            {task.blockedByPolicy !== undefined ? (
              task.blockedByPolicy
            ) : !task.enabled ? (
              t("settings.code.tasks.paused")
            ) : isWebhook ? (
              t("settings.code.tasks.listening")
            ) : task.nextRunAt ? (
              <>
                {t("settings.code.tasks.nextRun")} <ScheduledRelativeLabel value={task.nextRunAt} />
              </>
            ) : (
              t("settings.code.tasks.notScheduled")
            )}
          </span>
          {task.lastRunStatus !== "never" ? (
            <Badge variant={statusVariant(task.lastRunStatus)}>
              {LAST_RUN_STATUS_LABELS[task.lastRunStatus]
                ? t(LAST_RUN_STATUS_LABELS[task.lastRunStatus]!)
                : task.lastRunStatus}
            </Badge>
          ) : null}
          {task.threadId !== null && scheduledTaskThreadMode(task) !== "new_thread" ? (
            <ScheduledTaskThreadLink environmentId={environmentId} threadId={task.threadId} />
          ) : null}
          {task.lastRunError ? <span className="text-destructive">{task.lastRunError}</span> : null}
        </div>
      }
      control={
        <div className="flex items-center gap-2">
          <Switch
            checked={task.enabled}
            disabled={busy || !canOperate}
            aria-label={t("settings.code.tasks.enableAria", { name: task.title })}
            onCheckedChange={() => void act("toggle")}
          />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy || !canOperate}
                  aria-label={t("settings.code.tasks.actionsAria", { name: task.title })}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={onEdit}>
                <PencilIcon />
                {t("settings.code.tasks.edit")}
              </MenuItem>
              {isWebhook ? (
                <MenuItem onClick={() => setDeliveriesOpen(true)}>
                  <InboxIcon />
                  {t("settings.code.tasks.deliveries")}
                </MenuItem>
              ) : (
                <MenuItem onClick={() => void act("run")}>
                  <PlayIcon />
                  {t("settings.code.tasks.runNow")}
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem onClick={() => void act("delete")}>
                <Trash2Icon />
                {t("settings.code.tasks.delete")}
              </MenuItem>
            </MenuPopup>
          </Menu>
          {deliveriesOpen ? (
            <WebhookDeliveriesDialog
              environmentId={environmentId}
              task={task}
              onClose={() => setDeliveriesOpen(false)}
            />
          ) : null}
        </div>
      }
    />
  );
}

function ScheduledTaskThreadLink({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const ref = scopeThreadRef(environmentId, threadId);
  const title = useQuietThreadShell(ref)?.title.trim();
  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(ref)}
      className="max-w-64 truncate underline underline-offset-2 hover:text-foreground"
    >
      {title || "Open thread"}
    </Link>
  );
}

function WebhookDeliveriesDialog({
  environmentId,
  task,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly onClose: () => void;
}) {
  const t = useT();
  const deliveriesQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTaskWebhookDeliveries({
      environmentId,
      input: { id: task.id, acceptAnyOutcome: true },
    }),
  );
  const [selectedId, setSelectedId] = useState<ScheduledTaskWebhookDeliverySummary["id"] | null>(
    null,
  );
  const selectedQuery = useEnvironmentQuery(
    selectedId === null
      ? null
      : serverEnvironment.scheduledTaskWebhookDelivery({
          environmentId,
          input: { id: task.id, deliveryId: selectedId, acceptAnyOutcome: true },
        }),
  );
  const deliveries = deliveriesQuery.data?.deliveries ?? null;
  const selected = selectedQuery.data?.delivery ?? null;
  const error = selectedId === null ? deliveriesQuery.error : selectedQuery.error;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("settings.code.tasks.deliveriesTitle", { name: task.title })}
          </DialogTitle>
          <DialogDescription>{t("settings.code.tasks.deliveriesDescription")}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {selectedId !== null && selected === null && selectedQuery.error === null ? (
            <p className="text-sm text-muted-foreground" role="status">
              {t("settings.code.tasks.loadingDelivery")}
            </p>
          ) : selected ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge
                  variant={deliveryOutcomeVariant(
                    selected.pendingWindow ? "coalesced" : selected.outcome,
                  )}
                >
                  {webhookDeliveryLabel(selected, t)}
                </Badge>
                <span>
                  {selected.method} · <ScheduledRelativeLabel value={selected.receivedAt} />
                </span>
                {selected.signatureVerified ? (
                  <span className="text-muted-foreground">
                    {t("settings.code.tasks.signatureVerified")}
                  </span>
                ) : null}
              </div>
              {selected.error ? (
                <p
                  className={
                    selected.outcome === "filtered"
                      ? "text-sm text-muted-foreground"
                      : "text-sm text-destructive"
                  }
                >
                  {selected.error}
                </p>
              ) : null}
              <DeliveryBlock
                title={
                  selected.pendingWindow
                    ? t("settings.code.tasks.scheduledRun")
                    : t("settings.code.tasks.promptSent")
                }
              >
                {selected.renderedPrompt ??
                  (selected.pendingWindow
                    ? t("settings.code.tasks.runScheduledLater")
                    : t("settings.code.tasks.noRunStarted"))}
              </DeliveryBlock>
              {selected.missingFields.length > 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("settings.code.tasks.emptyPlaceholders", {
                    names: selected.missingFields.join(", "),
                  })}
                </p>
              ) : null}
              <DeliveryBlock title={t("settings.code.tasks.headers")}>
                {Object.entries(selected.headers)
                  .map(([name, value]) => `${name}: ${value}`)
                  .join("\n")}
              </DeliveryBlock>
              {selected.query ? (
                <DeliveryBlock title={t("settings.code.tasks.query")}>
                  {selected.query}
                </DeliveryBlock>
              ) : null}
              <DeliveryBlock
                title={
                  selected.bodyTruncated
                    ? t("settings.code.tasks.bodyTruncated")
                    : t("settings.code.tasks.body")
                }
              >
                {selected.body || t("settings.code.tasks.empty")}
              </DeliveryBlock>
            </div>
          ) : selectedId !== null ? null : deliveries === null ? (
            <p className="text-sm text-muted-foreground" role="status">
              {t("settings.code.tasks.loadingDeliveries")}
            </p>
          ) : deliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("settings.code.tasks.noRequests")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {deliveries.map((delivery) => (
                <li key={delivery.id}>
                  <button
                    type="button"
                    className="flex w-full flex-wrap items-center gap-2 py-2 text-left text-sm hover:bg-accent/40"
                    onClick={() => setSelectedId(delivery.id)}
                  >
                    <Badge
                      variant={deliveryOutcomeVariant(
                        delivery.pendingWindow ? "coalesced" : delivery.outcome,
                      )}
                    >
                      {webhookDeliveryLabel(delivery, t)}
                    </Badge>
                    <span>{delivery.method}</span>
                    <span className="text-muted-foreground">
                      <ScheduledRelativeLabel value={delivery.receivedAt} />
                    </span>
                    {delivery.outcome === "filtered" && delivery.error ? (
                      <span className="text-muted-foreground">{delivery.error}</span>
                    ) : null}
                    {delivery.missingFields.length > 0 ? (
                      <span className="text-muted-foreground">
                        {delivery.missingFields.length === 1
                          ? t("settings.code.tasks.emptyPlaceholderOne")
                          : t("settings.code.tasks.emptyPlaceholderMany", {
                              count: delivery.missingFields.length,
                            })}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter>
          {selectedId !== null ? (
            <Button variant="outline" size="sm" onClick={() => setSelectedId(null)}>
              {t("settings.code.tasks.back")}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={deliveriesQuery.isPending}
              onClick={deliveriesQuery.refresh}
            >
              {t("settings.code.tasks.refresh")}
            </Button>
          )}
          <DialogClose render={<Button size="sm" />}>{t("settings.code.tasks.done")}</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DeliveryBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label>{title}</Label>
      <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap break-all">
        {children}
      </pre>
    </div>
  );
}

function WebhookEndpointField({
  environmentId,
  task,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
}) {
  const t = useT();
  const canRotate = useAtomValue(
    serverEnvironment.rotateScheduledTaskWebhookToken.permissionAtom(environmentId),
  );
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "webhook URL" });
  const rotate = useAtomCommand(serverEnvironment.rotateScheduledTaskWebhookToken, {
    label: "scheduled task rotate webhook token",
  });
  const [rotating, setRotating] = useState(false);
  const endpoint = task?.webhook;
  if (!task || !endpoint) {
    return <p className="text-sm text-muted-foreground">{t("settings.code.tasks.urlAfterSave")}</p>;
  }
  const { address: url, copyable, note } = webhookAddress(endpoint, httpBaseUrl);
  const rotateUrl = async () => {
    const confirmed =
      (await requestConfirmDialog(t("settings.code.tasks.rotateConfirm"), {
        variant: "destructive",
      })) ?? window.confirm(t("settings.code.tasks.rotateConfirmInline"));
    if (!confirmed) return;
    setRotating(true);
    const result = await rotate({ environmentId, input: { id: task.id } });
    setRotating(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("settings.code.tasks.rotateFailed"),
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Input
          readOnly
          aria-label={t("settings.code.tasks.webhookUrl")}
          value={url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={!copyable}
          onClick={() => copyToClipboard(url, undefined)}
        >
          <CopyIcon />
          {isCopied ? t("settings.code.tasks.copied") : t("settings.code.tasks.copy")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={rotating || !canRotate}
          onClick={() => void rotateUrl()}
        >
          {t("settings.code.tasks.rotate")}
        </Button>
      </div>
      {note !== null ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      {endpoint.url !== null ? <WebhookDeliveryMode environmentId={environmentId} /> : null}
    </div>
  );
}

function WebhookDeliveryMode({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const t = useT();
  const cloudLink = usePrimaryCloudLinkState();
  if (cloudLink.target?.environmentId !== environmentId || cloudLink.data === null) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {cloudLink.data.holdWebhooksWhileOffline
        ? t("settings.code.tasks.heldOffline")
        : t("settings.code.tasks.forwardedLive")}{" "}
      <Link to="/settings/access" className="underline underline-offset-2">
        {t("settings.code.tasks.changeInSharing")}
      </Link>
    </p>
  );
}

function ScheduledTaskEditorDialog({
  initialEnvironmentId,
  task,
  onClose,
}: {
  readonly initialEnvironmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
  readonly onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      {/* The form owns the draft so a keystroke re-renders it, not the dialog chrome. */}
      <DialogPopup className="max-w-xl">
        <ScheduledTaskEditorForm
          initialEnvironmentId={initialEnvironmentId}
          task={task}
          saving={saving}
          onSavingChange={setSaving}
          onClose={onClose}
        />
      </DialogPopup>
    </Dialog>
  );
}

const THREAD_MODE_LABELS: Record<ScheduledTaskThreadMode, MessageKey> = {
  new_thread: "settings.code.tasks.modeNewThread",
  continue: "settings.code.tasks.modeContinue",
  fresh_session: "settings.code.tasks.modeFreshSession",
};

function ScheduledTaskDestination({
  environmentId,
  projectId,
  threadId,
  threadMode,
  disabled,
  onSelect,
  onThreadModeChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly threadId: ThreadId | null;
  readonly threadMode: ScheduledTaskThreadMode;
  readonly disabled: boolean;
  readonly onSelect: (thread: { id: ThreadId; projectId: ProjectId } | null) => void;
  /** Absent on servers that predate thread modes. */
  readonly onThreadModeChange: ((mode: ScheduledTaskThreadMode) => void) | undefined;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = threadId === null ? null : scopeThreadRef(environmentId, threadId);
  const shell = useThreadShell(ref);
  // The shell can omit older settled threads; their family read still carries the title.
  const family = useEnvironmentQuery(
    ref !== null && shell === null ? threadFamilies.familyAtom(environmentId, ref.threadId) : null,
  );
  const thread = shell ?? family.data?.threads.find((row) => row.id === threadId);
  const currentLabel =
    ref !== null
      ? thread?.title.trim() || t("settings.code.tasks.threadFallback", { id: ref.threadId })
      : threadMode === "new_thread"
        ? t("settings.code.tasks.modeNewThread")
        : t("settings.code.tasks.startedByFirstRun");
  const shells = useVisibleThreadShells(open);
  // Mounts older settled threads matching the query, which shells may leave out.
  useThreadSearch(open && projectId ? [environmentId] : [], query, {
    titlesOnly: true,
    projectIds: [projectId as ProjectId],
  });
  const threads = scheduledTaskDestinationThreads(shells, {
    environmentId,
    projectId,
    currentThreadId: threadId,
    query,
  });
  const search = query.trim().toLocaleLowerCase();
  const items: ReadonlyArray<string> = [
    ...(search ? [] : [NEW_THREAD_DESTINATION]),
    ...(threadId !== null && currentLabel.toLocaleLowerCase().includes(search) ? [threadId] : []),
    ...threads.map((row) => row.id),
  ];
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  const detail =
    threadMode === "new_thread"
      ? "Each run starts a new thread with the workspace and model below."
      : ref === null
        ? threadMode === "continue"
          ? "The first run starts a thread with the workspace and model below. Later runs continue that conversation."
          : "The first run starts a thread with the workspace and model below. Later runs post there, each in a fresh session without earlier runs' context."
        : threadMode === "continue"
          ? "Each run continues this conversation, in its workspace and with its current model."
          : "Each run starts a fresh session in this thread, without earlier runs' context.";
  return (
    <Field label={t("settings.code.tasks.destination")} htmlFor="scheduled-task-destination">
      {onThreadModeChange ? (
        <Select
          value={threadMode}
          onValueChange={(value) => onThreadModeChange(value as ScheduledTaskThreadMode)}
        >
          <SelectTrigger size="sm" id="scheduled-task-destination">
            <SelectValue>{t(THREAD_MODE_LABELS[threadMode])}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {(Object.keys(THREAD_MODE_LABELS) as ScheduledTaskThreadMode[]).map((mode) => (
              <SelectItem key={mode} value={mode}>
                {t(THREAD_MODE_LABELS[mode])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
      {!onThreadModeChange || threadMode !== "new_thread" ? (
        <Combobox
          items={items}
          filteredItems={items}
          filter={null}
          autoHighlight
          open={open && !disabled}
          onOpenChange={handleOpenChange}
          value={threadId ?? (threadMode === "new_thread" ? NEW_THREAD_DESTINATION : null)}
          onValueChange={(value) => {
            if (value === NEW_THREAD_DESTINATION) {
              onSelect(null);
              handleOpenChange(false);
              return;
            }
            const picked = threads.find((row) => row.id === value);
            if (picked) onSelect(picked);
            handleOpenChange(false);
          }}
        >
          <ComboboxTrigger
            id={
              onThreadModeChange
                ? "scheduled-task-destination-thread"
                : "scheduled-task-destination"
            }
            aria-label={onThreadModeChange ? t("settings.code.tasks.destinationThread") : undefined}
            disabled={disabled}
            render={<Button variant="outline" size="sm" />}
            className="w-full justify-between"
          >
            <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-left">{currentLabel}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </ComboboxTrigger>
          <ComboboxPopup align="start" side="bottom" className="w-80">
            <ComboboxSearchInput
              aria-label={t("misc.sidebar.searchThreads")}
              placeholder={t("settings.code.tasks.searchAllThreads")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <ComboboxEmpty>{t("settings.code.tasks.noThreads")}</ComboboxEmpty>
            <ComboboxList className="max-h-72">
              {items.map((value, index) => (
                <ComboboxItem key={value} index={index} value={value}>
                  <span className="block truncate">
                    {value === NEW_THREAD_DESTINATION
                      ? t("settings.code.tasks.modeNewThread")
                      : value === threadId
                        ? currentLabel
                        : threads.find((row) => row.id === value)?.title ||
                          t("review.extra.untitled.thread")}
                  </span>
                </ComboboxItem>
              ))}
            </ComboboxList>
          </ComboboxPopup>
        </Combobox>
      ) : null}
      <div className="space-y-1 text-sm">
        <p className="text-muted-foreground">{detail}</p>
        {threadMode !== "new_thread" ? (
          <p className="text-muted-foreground">{t("settings.code.tasks.deleteWithThread")}</p>
        ) : null}
      </div>
    </Field>
  );
}

function ScheduledTaskEditorForm({
  initialEnvironmentId,
  task,
  saving,
  onSavingChange: setSaving,
  onClose,
}: {
  readonly initialEnvironmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
  readonly saving: boolean;
  readonly onSavingChange: (saving: boolean) => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  const { scope, connectedEnvironments } = useSettingsScope();
  const [environmentId, setEnvironmentId] = useState(initialEnvironmentId);
  const environment = useEnvironment(environmentId);
  // Older servers reject one-time schedules, so offer Once only where it can save.
  const offersOnce =
    environment?.serverConfig?.environment.capabilities.oneTimeSchedules === true ||
    task?.schedule.type === "once";
  const offersThreadModes =
    environment?.serverConfig?.environment.capabilities.scheduledTaskThreadModes === true;
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  const tasksQuery = useEnvironmentQuery(
    connected ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} }) : null,
  );
  const allProjects = useProjects();
  const projectsOn = (id: EnvironmentId) =>
    allProjects.filter(
      (project) => project.environmentId === id && matchesScheduledTaskScope(scope, id, project.id),
    );
  const scopedProjects = projectsOn(environmentId);
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const upsertTask = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "scheduled task upsert",
  });
  const webhookDenial = managedCapabilityDenial(useManagedPolicy(environmentId), "webhookTasks");
  const [draft, setDraft] = useState<DraftState>(() =>
    task
      ? taskToDraft(task)
      : {
          ...EMPTY_DRAFT,
          projectId: defaultScheduledTaskProjectId(scopedProjects, scope),
        },
  );
  // Pinned first. The chosen project stays listed after it is archived.
  const projects = scopedProjects
    .filter(
      (project) =>
        project.archivedAt == null ||
        project.id === draft.projectId ||
        project.id === task?.projectId,
    )
    .sort((left, right) => Number(right.pinnedAt != null) - Number(left.pinnedAt != null));
  const submissionPending = useRef(false);
  const editingTaskMissing =
    draft.editingId !== null &&
    tasksQuery.data !== null &&
    !tasksQuery.data.tasks.some((entry) => entry.id === draft.editingId);
  const liveTask = tasksQuery.data
    ? (tasksQuery.data.tasks.find((entry) => entry.id === draft.editingId) ?? null)
    : task;
  const selectedProjectId = draft.projectId || projects[0]?.id || "";
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const instanceEntries = providerInstanceEntriesFor(
    providers,
    settings,
    selectedProject?.id ?? null,
  );

  const firstInstance = instanceEntries[0];
  const draftSelection = draft.modelKey ? splitModelKey(draft.modelKey) : null;
  const activeSelection =
    draftSelection &&
    instanceEntries.some((entry) => entry.instanceId === draftSelection.instanceId && entry.enabled)
      ? draftSelection
      : scheduledTaskDefaultModel(settings, selectedProject ?? null, instanceEntries);
  const activeInstanceId =
    activeSelection?.instanceId ?? firstInstance?.instanceId ?? ("" as ProviderInstanceId);
  const activeModel = activeSelection?.model ?? "";
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    activeInstanceId,
    activeModel,
  );

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const submit = async () => {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      submissionPending.current ||
      saving ||
      editingTaskMissing ||
      !connected ||
      tasksQuery.data === null
    )
      return;
    const selection = activeSelection;
    if (
      !draft.title.trim() ||
      !draft.prompt.trim() ||
      !projects.some((project) => project.id === selectedProjectId) ||
      selection === null
    ) {
      reportFailure(t("settings.code.tasks.incomplete"), t("settings.code.tasks.incompleteHint"));
      return;
    }
    const parsedFilters = parseWebhookFilterDrafts(draft.filters);
    if (draft.scheduleMode === "webhook" && "error" in parsedFilters) {
      reportFailure(t("settings.code.tasks.invalidFilter"), parsedFilters.error);
      return;
    }
    const schedule = scheduleFromDraft(draft);
    if (schedule === null) {
      for (const error of scheduleDraftErrors(draft, t))
        reportFailure(error.title, error.description);
      return;
    }
    if (
      schedule.type === "webhook" &&
      schedule.signature &&
      (!schedule.signature.header ||
        (!schedule.signature.secret &&
          !(liveTask?.schedule.type === "webhook" && liveTask.webhook?.hasSecret)))
    ) {
      reportFailure(
        t("settings.code.tasks.secretRequired"),
        t("settings.code.tasks.secretRequiredHint"),
      );
      return;
    }
    if (
      schedule.type === "interval" &&
      (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS)
    ) {
      reportFailure(
        t("settings.code.tasks.invalidInterval"),
        t("settings.code.tasks.invalidIntervalHint"),
      );
      return;
    }
    if (schedule.type === "once" && !offersOnce) {
      reportFailure(
        t("settings.code.tasks.onceUnavailable"),
        t("settings.code.tasks.onceUnavailableHint"),
      );
      return;
    }
    if (draft.workspaceMode === "existing_worktree" && !draft.existingWorktreePath.trim()) {
      reportFailure(
        t("settings.code.tasks.pathRequired"),
        t("settings.code.tasks.pathRequiredHint"),
      );
      return;
    }
    const modelSelection =
      draft.baseModelSelection !== null &&
      draft.baseModelSelection.instanceId === selection.instanceId &&
      draft.baseModelSelection.model === selection.model
        ? draft.baseModelSelection
        : selection;
    const workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy =
      draft.workspaceMode === "root"
        ? { type: "root" }
        : draft.workspaceMode === "existing_worktree"
          ? { type: "existing_worktree", worktreePath: draft.existingWorktreePath.trim() }
          : {
              type: "worktree",
              baseRef: draft.baseRef.trim() || "main",
              startFromOrigin: draft.startFromOrigin,
            };
    const input: ScheduledTaskUpsertInput = {
      ...(draft.editingId ? { id: draft.editingId as ScheduledTaskId, requireExisting: true } : {}),
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      enabled: draft.enabled,
      schedule,
      projectId: selectedProjectId as ProjectId,
      threadId: draft.threadId ? (draft.threadId as ThreadId) : null,
      ...(offersThreadModes ? { threadMode: draft.threadMode } : {}),
      workspaceStrategy,
      modelSelection,
      // Tasks have no mode picker; a mode above the administrator's ceiling would fail every run.
      runtimeMode:
        clampManagedRuntimeMode(environment?.serverConfig?.managedPolicy, draft.runtimeMode) ??
        draft.runtimeMode,
      interactionMode: draft.interactionMode,
      creationSource: "web",
    };
    // Lock before React renders, and keep successful creates locked until the form closes.
    submissionPending.current = true;
    setSaving(true);
    const result = await upsertTask({ environmentId, input });
    setSaving(false);
    if (result._tag === "Failure") {
      submissionPending.current = false;
      if (!isAtomCommandInterrupted(result)) {
        reportFailure(t("settings.code.tasks.saveFailed"), squashAtomCommandFailure(result));
      }
      return;
    }
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {draft.editingId ? t("settings.code.tasks.editTask") : t("settings.code.tasks.newTask")}
        </DialogTitle>
        <DialogDescription>{t("settings.code.tasks.editorDescription")}</DialogDescription>
      </DialogHeader>

      <DialogPanel>
        {/* Fieldsets default to min-width: min-content, which lets one wide control widen the form past the dialog. */}
        <fieldset disabled={saving} className="min-w-0 space-y-5">
          {!connected ? (
            <p className="text-sm text-destructive">{t("settings.code.tasks.reconnectToSave")}</p>
          ) : null}
          <Field label={t("settings.code.tasks.runsOn")} htmlFor="scheduled-task-environment">
            <Select
              value={environmentId}
              disabled={task !== null || saving}
              onValueChange={(id) => {
                const next = connectedEnvironments.find((entry) => entry.environmentId === id);
                if (!next) return;
                setEnvironmentId(next.environmentId);
                setDraft((current) => ({
                  ...unbindDraftFromThread(current),
                  projectId: defaultScheduledTaskProjectId(projectsOn(next.environmentId), scope),
                  modelKey: "",
                  baseModelSelection: null,
                  baseRef: "main",
                  startFromOrigin: true,
                  existingWorktreePath: "",
                }));
              }}
            >
              <SelectTrigger id="scheduled-task-environment" size="sm">
                <SelectValue>
                  <span className="flex items-center gap-2">
                    <EnvironmentMachineIcon
                      kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
                      className="size-4"
                    />
                    {environment?.label ?? t("settings.code.tasks.unavailableEnvironment")}
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {connectedEnvironments.map((entry) => {
                  const { secondary } = settingsScopeEnvironmentLabels(
                    entry,
                    connectedEnvironments,
                  );
                  return (
                    <SelectItem
                      key={entry.environmentId}
                      value={entry.environmentId}
                      label={entry.label}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <EnvironmentMachineIcon
                          kind={resolveEnvironmentMachineKind(entry.serverConfig)}
                          className="size-4"
                        />
                        <span className="min-w-0">
                          <span className="block truncate">{entry.label}</span>
                          {secondary ? (
                            <span className="block max-w-72 truncate text-xs text-muted-foreground">
                              {secondary}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectPopup>
            </Select>
          </Field>
          {tasksQuery.error ? (
            <p className="text-sm text-destructive" role="status">
              {tasksQuery.error}
            </p>
          ) : null}
          {editingTaskMissing ? (
            <p className="text-xs text-destructive" role="status">
              {t("settings.code.tasks.taskGone")}
            </p>
          ) : null}
          <Field label={t("settings.code.tasks.name")} htmlFor="scheduled-task-title">
            <Input
              id="scheduled-task-title"
              placeholder={t("settings.code.tasks.namePlaceholder")}
              value={draft.title}
              onChange={(event) =>
                setDraft((current) => ({ ...current, title: event.target.value }))
              }
            />
          </Field>

          <ScheduledTaskDestination
            environmentId={environmentId}
            projectId={selectedProjectId}
            threadId={draft.threadId ? (draft.threadId as ThreadId) : null}
            threadMode={draft.threadMode}
            disabled={saving || !connected}
            onSelect={(thread) =>
              setDraft((current) =>
                thread === null
                  ? { ...unbindDraftFromThread(current), threadMode: "new_thread" }
                  : moveDraftToThread(current, thread),
              )
            }
            onThreadModeChange={
              offersThreadModes
                ? (threadMode) =>
                    setDraft((current) => ({
                      ...(threadMode === "new_thread" ? unbindDraftFromThread(current) : current),
                      threadMode,
                    }))
                : undefined
            }
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("settings.code.tasks.project")} htmlFor="scheduled-task-project">
              <Select
                value={selectedProjectId}
                onValueChange={(projectId) =>
                  setDraft((current) => changeDraftProject(current, projectId ?? ""))
                }
              >
                <SelectTrigger size="sm" id="scheduled-task-project">
                  <SelectValue placeholder={t("settings.code.tasks.selectProject")}>
                    {selectedProject?.title}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id} label={project.title}>
                      <span className="block truncate">{project.title}</span>
                      {allProjects.some(
                        (other) =>
                          other.title === project.title &&
                          (other.environmentId !== project.environmentId ||
                            other.id !== project.id),
                      ) ? (
                        <span className="block max-w-72 truncate text-xs text-muted-foreground">
                          {project.workspaceRoot}
                        </span>
                      ) : null}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>

            <Field label={t("settings.code.tasks.workspace")} htmlFor="scheduled-task-workspace">
              <Select
                value={draft.workspaceMode}
                onValueChange={(value) =>
                  setDraft((current) => ({ ...current, workspaceMode: value as WorkspaceMode }))
                }
              >
                <SelectTrigger size="sm" id="scheduled-task-workspace">
                  <SelectValue>{t(WORKSPACE_MODE_LABELS[draft.workspaceMode])}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="worktree">{t(WORKSPACE_MODE_LABELS.worktree)}</SelectItem>
                  <SelectItem value="root">{t(WORKSPACE_MODE_LABELS.root)}</SelectItem>
                  <SelectItem value="existing_worktree">
                    {t(WORKSPACE_MODE_LABELS.existing_worktree)}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </Field>
          </div>

          {draft.workspaceMode === "worktree" ? (
            <Field label={t("settings.code.tasks.baseBranch")} htmlFor="scheduled-task-base-ref">
              <WorktreeBaseBranchPicker
                key={`${environmentId}:${selectedProjectId}`}
                id="scheduled-task-base-ref"
                environmentId={environmentId}
                cwd={selectedProject?.workspaceRoot ?? null}
                value={draft.baseRef}
                onValueChange={(baseRef) => setDraft((current) => ({ ...current, baseRef }))}
                startFromOrigin={draft.startFromOrigin}
                onStartFromOriginChange={(startFromOrigin) =>
                  setDraft((current) => ({ ...current, startFromOrigin }))
                }
                disabled={saving || !connected}
              />
            </Field>
          ) : null}
          {draft.workspaceMode === "existing_worktree" ? (
            <Field label={t("settings.code.tasks.checkoutPath")} htmlFor="scheduled-task-checkout">
              <Input
                id="scheduled-task-checkout"
                value={draft.existingWorktreePath}
                placeholder="/path/to/checkout"
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    existingWorktreePath: resolvePastedPath(
                      current.existingWorktreePath,
                      event.target.value,
                    ),
                  }))
                }
              />
            </Field>
          ) : null}

          <Field label={t("settings.code.tasks.prompt")} htmlFor="scheduled-task-prompt">
            <Textarea
              id="scheduled-task-prompt"
              className="max-h-64 overflow-y-auto"
              placeholder={t("settings.code.tasks.promptPlaceholder")}
              value={draft.prompt}
              onChange={(event) =>
                setDraft((current) => ({ ...current, prompt: event.target.value }))
              }
            />
          </Field>

          <Field label={t("settings.code.tasks.model")}>
            <div>
              <ProviderModelPicker
                environmentId={environmentId}
                disabled={saving || !connected}
                activeInstanceId={activeInstanceId}
                model={activeModel}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                isComposerOwned={false}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onInstanceModelChange={(instanceId, model) =>
                  setDraft((current) => ({ ...current, modelKey: `${instanceId}:${model}` }))
                }
              />
            </div>
          </Field>

          <div className="space-y-3">
            {task?.schedule.type === "interval" &&
            task.schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS ? (
              <p className="text-sm text-muted-foreground" role="status">
                {t("settings.code.tasks.legacyInterval")}
              </p>
            ) : null}
            {/* Wraps the toggle below the label when both don't fit, as on phones. */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>{t("settings.code.tasks.schedule")}</Label>
              <ToggleGroup
                aria-label={t("settings.code.tasks.scheduleType")}
                value={[draft.scheduleMode]}
                onValueChange={(values) => {
                  const mode = values[0] as ScheduleMode | undefined;
                  if (
                    mode === "fixed" ||
                    mode === "once" ||
                    mode === "interval" ||
                    mode === "webhook"
                  )
                    setDraft((current) => {
                      const suggested =
                        mode === "once" && !current.runAt
                          ? new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000)
                          : null;
                      return {
                        ...current,
                        scheduleMode: mode,
                        // Keep the instant too, so an hour that repeats when clocks go back stays exact.
                        ...(suggested === null
                          ? {}
                          : {
                              runAt: toDateTimeLocalValue(suggested),
                              savedRunAt: suggested.toISOString(),
                            }),
                        prompt:
                          mode === "webhook" && !current.prompt.trim()
                            ? DEFAULT_WEBHOOK_PROMPT
                            : current.prompt,
                      };
                    });
                }}
              >
                <Toggle value="fixed">{t("settings.code.tasks.modeFixed")}</Toggle>
                {offersOnce || draft.scheduleMode === "once" ? (
                  <Toggle value="once">{t("settings.code.tasks.modeOnce")}</Toggle>
                ) : null}
                <Toggle value="interval">{t("settings.code.tasks.modeInterval")}</Toggle>
                <Toggle
                  value="webhook"
                  disabled={webhookDenial !== undefined && draft.scheduleMode !== "webhook"}
                >
                  {t("settings.code.tasks.onWebhook")}
                </Toggle>
              </ToggleGroup>
            </div>

            {webhookDenial !== undefined ? (
              <ManagedNotice>
                {draft.scheduleMode === "webhook"
                  ? `${webhookDenial} ${t("settings.code.tasks.webhookDeniedSaveHint")}`
                  : webhookDenial}
              </ManagedNotice>
            ) : null}
            {/* A disabled task still saves, so keep its fields reachable for fixing. */}
            {draft.scheduleMode === "webhook" &&
            webhookDenial !== undefined &&
            draft.enabled ? null : draft.scheduleMode === "webhook" ? (
              <div className="space-y-4">
                <WebhookEndpointField environmentId={environmentId} task={liveTask} />
                <p className="text-xs text-muted-foreground">
                  {t("settings.code.tasks.webhookPromptHint")}
                </p>
                <Field
                  label={t("settings.code.tasks.skipOlder")}
                  hint={t("settings.code.tasks.minutesOptional")}
                  htmlFor="scheduled-task-max-age"
                >
                  <Input
                    id="scheduled-task-max-age"
                    type="number"
                    nativeInput
                    min={1}
                    max={MAX_WEBHOOK_DELIVERY_AGE_MINUTES}
                    placeholder={t("settings.code.tasks.runEveryRequest")}
                    value={draft.maxDeliveryAgeMinutes}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        maxDeliveryAgeMinutes: event.target.value,
                      }))
                    }
                  />
                </Field>
                <WebhookFiltersField
                  filters={draft.filters}
                  onChange={(filters) => setDraft((current) => ({ ...current, filters }))}
                />
                <Field
                  label={t("settings.code.tasks.duplicateKey")}
                  hint={t("settings.code.tasks.templateOptional")}
                  htmlFor="scheduled-task-replay-key"
                >
                  <Input
                    id="scheduled-task-replay-key"
                    placeholder="{{headers.delivery-id}}"
                    value={draft.replayKey}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, replayKey: event.target.value }))
                    }
                  />
                </Field>
                <p className="text-xs text-muted-foreground">
                  {t("settings.code.tasks.duplicateHint")}
                </p>
                <Field
                  label={t("settings.code.tasks.coalesceKey")}
                  hint={t("settings.code.tasks.templateOptional")}
                  htmlFor="scheduled-task-coalesce-key"
                >
                  <Input
                    id="scheduled-task-coalesce-key"
                    placeholder="{{body.id}}"
                    value={draft.coalesceKey}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, coalesceKey: event.target.value }))
                    }
                  />
                </Field>
                <Field
                  label={t("settings.code.tasks.coalesceWindow")}
                  hint={t("settings.code.tasks.secondsRange")}
                  htmlFor="scheduled-task-coalesce-window"
                >
                  <Input
                    id="scheduled-task-coalesce-window"
                    type="number"
                    nativeInput
                    min={10}
                    max={3600}
                    placeholder="120"
                    value={draft.coalesceWindowSeconds}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        coalesceWindowSeconds: event.target.value,
                      }))
                    }
                  />
                </Field>
                <p className="text-xs text-muted-foreground">
                  {t("settings.code.tasks.coalesceHint")}
                </p>
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 space-y-1">
                    <Label htmlFor="scheduled-task-signature">
                      {t("settings.code.tasks.requireSignature")}
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {t("settings.code.tasks.requireSignatureHint")}
                    </p>
                  </div>
                  <Switch
                    id="scheduled-task-signature"
                    checked={draft.signatureEnabled}
                    onCheckedChange={(signatureEnabled) =>
                      setDraft((current) => ({ ...current, signatureEnabled }))
                    }
                  />
                </div>
                {draft.signatureEnabled ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field
                      label={t("settings.code.tasks.header")}
                      htmlFor="scheduled-task-signature-header"
                    >
                      <Input
                        id="scheduled-task-signature-header"
                        value={draft.signatureHeader}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            signatureHeader: event.target.value,
                          }))
                        }
                      />
                    </Field>
                    <Field
                      label={t("settings.code.tasks.prefix")}
                      htmlFor="scheduled-task-signature-prefix"
                    >
                      <Input
                        id="scheduled-task-signature-prefix"
                        value={draft.signaturePrefix}
                        placeholder={t("settings.code.tasks.none")}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            signaturePrefix: event.target.value,
                          }))
                        }
                      />
                    </Field>
                    <Field
                      label={t("settings.code.tasks.encoding")}
                      htmlFor="scheduled-task-signature-encoding"
                    >
                      <Select
                        value={draft.signatureEncoding}
                        onValueChange={(value) =>
                          setDraft((current) => ({
                            ...current,
                            signatureEncoding: value === "base64" ? "base64" : "hex",
                          }))
                        }
                      >
                        <SelectTrigger size="sm" id="scheduled-task-signature-encoding">
                          <SelectValue>{draft.signatureEncoding}</SelectValue>
                        </SelectTrigger>
                        <SelectPopup>
                          <SelectItem value="hex">hex</SelectItem>
                          <SelectItem value="base64">base64</SelectItem>
                        </SelectPopup>
                      </Select>
                    </Field>
                    <Field
                      label={t("settings.code.tasks.secret")}
                      htmlFor="scheduled-task-signature-secret"
                    >
                      <Input
                        id="scheduled-task-signature-secret"
                        type="password"
                        autoComplete="off"
                        value={draft.signatureSecret}
                        placeholder={
                          liveTask?.schedule.type === "webhook" && liveTask.webhook?.hasSecret
                            ? t("settings.code.tasks.secretUnchanged")
                            : t("settings.code.tasks.secretPlaceholder")
                        }
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            signatureSecret: event.target.value,
                          }))
                        }
                      />
                    </Field>
                  </div>
                ) : null}
              </div>
            ) : draft.scheduleMode === "once" ? (
              <div className="flex items-center gap-2">
                <Label htmlFor="scheduled-task-run-at">{t("settings.code.tasks.runOn")}</Label>
                <Input
                  type="datetime-local"
                  id="scheduled-task-run-at"
                  nativeInput
                  className="w-56"
                  value={draft.runAt}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, runAt: event.target.value }))
                  }
                />
              </div>
            ) : draft.scheduleMode === "fixed" ? (
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <Label htmlFor="scheduled-task-time">{t("settings.code.tasks.runAt")}</Label>
                  <Input
                    type="time"
                    id="scheduled-task-time"
                    nativeInput
                    className="w-32"
                    value={draft.timeOfDay}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, timeOfDay: event.target.value }))
                    }
                  />
                  <span className="text-xs text-muted-foreground">
                    {t("settings.code.tasks.onDays")}
                  </span>
                </div>
                <ToggleGroup
                  multiple
                  variant="outline"
                  size="sm"
                  aria-label={t("settings.code.tasks.daysToRun")}
                  value={[...draft.weekdays].map(String)}
                  onValueChange={(values) => {
                    if (values.length === 0) return;
                    setDraft((current) => ({
                      ...current,
                      weekdays: new Set(values.map(Number)),
                    }));
                  }}
                >
                  {WEEKDAY_ORDER.map((day) => (
                    <Toggle key={day} value={String(day)} aria-label={t(WEEKDAY_LABELS[day])}>
                      {t(WEEKDAY_SHORT[day])}
                    </Toggle>
                  ))}
                </ToggleGroup>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Label htmlFor="scheduled-task-interval">{t("settings.code.tasks.runEvery")}</Label>
                <Input
                  type="number"
                  id="scheduled-task-interval"
                  nativeInput
                  min={1}
                  step="any"
                  className="w-24"
                  value={draft.intervalMinutes}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, intervalMinutes: event.target.value }))
                  }
                />
                <span className="text-xs text-muted-foreground">
                  {t("settings.code.tasks.minutes")}
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <Label htmlFor="scheduled-task-enabled">{t("settings.code.tasks.enabled")}</Label>
              <p id="scheduled-task-enabled-description" className="text-sm text-muted-foreground">
                {t("settings.code.tasks.enabledHint")}
              </p>
            </div>
            <Switch
              id="scheduled-task-enabled"
              aria-describedby="scheduled-task-enabled-description"
              checked={draft.enabled}
              onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
            />
          </div>
        </fieldset>
      </DialogPanel>

      <DialogFooter>
        <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
          {t("settings.code.tasks.cancel")}
        </DialogClose>
        <Button
          size="sm"
          disabled={
            !canOperate ||
            saving ||
            editingTaskMissing ||
            !connected ||
            !tasksQuery.data ||
            (draft.enabled && draft.scheduleMode === "webhook" && webhookDenial !== undefined)
          }
          onClick={() => void submit()}
        >
          {draft.editingId
            ? t("settings.code.tasks.saveTask")
            : t("settings.code.tasks.createTask")}
        </Button>
      </DialogFooter>
    </>
  );
}
