import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { managedCapabilityDenial } from "@t3tools/client-runtime/contract-labels";
import { useAtomValue } from "@effect/atom-react";
import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import { AsyncResult } from "effect/reactivity";
import {
  AlarmClockIcon,
  ArrowRightIcon,
  CalendarClockIcon,
  ChevronDownIcon,
  Clock3Icon,
  CopyIcon,
  FlaskConicalIcon,
  GitBranchIcon,
  InboxIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PackageIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import type {
  EnvironmentId,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  ScheduledTask,
  ScheduledTaskId,
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
import { scheduleTimeZoneLabel } from "@t3tools/client-runtime/scheduled-task-time-zone";
import { scheduledTaskWorktreeBaseRef } from "@t3tools/client-runtime/scheduled-task-worktree";
import {
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  MAX_WEBHOOK_FILTERS,
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ProviderInstanceId,
  resolveEnvironmentMachineKind,
  scheduledTaskThreadMode,
  trimAsciiWhitespace,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { msg, T, useGT, useLocale, useMessages, Var } from "gt-react";
import { m, type MessageResolver } from "../../i18n/messages";

import { formatRelativeTime } from "../../timestampFormat";
import { useClientSettings, useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance, selectsPlanAgent } from "../../modelSelection";
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
import { usePaginatedBranches, useThreadSearch } from "../../state/queries";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { threadFamilies } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorktreeBaseBranchPicker } from "../WorktreeBaseBranchPicker";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { StatusDot } from "../ui/status-dot";
import { AuthOrchestrationOperateScope, clampManagedRuntimeMode } from "@t3tools/contracts";
import { resolvePastedPath } from "@t3tools/shared/path";
import { useManagedPolicy } from "~/state/managedPolicy";
import { ManagedNotice } from "../ManagedPolicy";
import { readEnvironmentScope } from "~/state/session";
import { useSettingsScope } from "./SettingsScopeContext";
import { EnvironmentRow, useEnvironmentTransportLabel } from "./EnvironmentRow";
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
  scheduleLabel,
  scheduledTaskDefaultModel,
  weekdayShortLabel,
  taskToDraft,
  unbindDraftFromThread,
  type DraftState,
  type ScheduleMode,
} from "./scheduledTasksSettings.logic";
import { Label } from "../ui/label";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "../ui/menu";
import { ToggleGroup, Toggle } from "../ui/toggle-group";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { createModelSelection } from "@t3tools/shared/model";
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
import { Kbd } from "../ui/kbd";
import { isMacPlatform } from "../../lib/utils";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  SettingsEmptyState,
  SettingsEmptyTile,
  SettingsEmptyTiles,
  SettingsLoadingRows,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

// Thread ids are trimmed, so the leading space keeps this from matching one.
const NEW_THREAD_DESTINATION = " new-thread";

const SCOPE_SUMMARY_TEMPLATES: Record<string, string> = {
  "Not connected:": msg("Not connected: {environments}"),
  "Loading scheduled tasks on": msg("Loading scheduled tasks on {environments}"),
  "Could not load scheduled tasks:": msg("Could not load scheduled tasks: {environments}"),
  "No tasks on": msg("No tasks on {environments}"),
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
  savedThreadId: "",
  threadMode: "new_thread",
  workspaceMode: "worktree",
  baseRef: "",
  startFromOrigin: true,
  existingWorktreePath: "",
  modelSelection: null,
  runtimeMode: "full-access",
  interactionMode: "default",
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

/** Starting points offered while an environment has no tasks; each opens the editor prefilled. */
const TASK_TEMPLATES = [
  {
    icon: PackageIcon,
    badge: msg("Daily at 02:00"),
    title: msg("Nightly dependency check"),
    description: msg("Update outdated dependencies and open a PR if tests pass."),
    draft: {
      timeOfDay: "02:00",
      weekdays: new Set([0, 1, 2, 3, 4, 5, 6]),
    },
  },
  {
    icon: InboxIcon,
    badge: msg("Weekdays at 09:30"),
    title: msg("Triage new issues"),
    description: msg("Label and summarize issues opened since yesterday."),
    draft: { timeOfDay: "09:30" },
  },
  {
    icon: FlaskConicalIcon,
    badge: msg("Every 6 hours"),
    title: msg("Watch flaky tests"),
    description: msg("Rerun the flaky suite and report tests that failed twice."),
    draft: { scheduleMode: "interval", intervalMinutes: "360" },
  },
] as const satisfies readonly {
  icon: typeof PackageIcon;
  badge: string;
  title: string;
  description: string;
  draft: Partial<DraftState>;
}[];

function WebhookFiltersField({
  filters,
  onChange,
}: {
  filters: ReadonlyArray<WebhookFilterDraft>;
  onChange: (filters: ReadonlyArray<WebhookFilterDraft>) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const update = (index: number, patch: Partial<WebhookFilterDraft>) =>
    onChange(filters.map((filter, at) => (at === index ? { ...filter, ...patch } : filter)));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <Label>
            <T>Filters</T>
          </Label>
          <p className="text-body text-muted-foreground">
            <T>
              Run only when every filter matches. Other requests are logged as filtered. Separate
              “is one of” values with commas; a value can't contain a comma.
            </T>
          </p>
        </div>
        <Button
          className="shrink-0"
          variant="secondary"
          size="sm"
          disabled={filters.length >= MAX_WEBHOOK_FILTERS}
          onClick={() => onChange([...filters, emptyWebhookFilterDraft()])}
        >
          <PlusIcon />
          <T>Add filter</T>
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
                aria-label={gt("Filter {number} path", { number: index + 1 })}
                placeholder="body.action"
                value={filter.path}
                onChange={(event) => update(index, { path: event.target.value })}
              />
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={gt("Remove filter {number}", { number: index + 1 })}
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
                  aria-label={gt("Filter {number} test", { number: index + 1 })}
                >
                  <SelectValue>
                    {messages(WEBHOOK_FILTER_OPS.find((option) => option.op === filter.op)?.label)}
                  </SelectValue>
                </SelectTrigger>
              </div>
              <SelectPopup>
                {WEBHOOK_FILTER_OPS.map((option) => (
                  <SelectItem key={option.op} value={option.op}>
                    {messages(option.label)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {filter.op === "exists" ? null : (
              <div className="grid min-w-0 flex-1 grid-cols-1">
                <Input
                  aria-label={gt("Filter {number} value", { number: index + 1 })}
                  // oxlint-disable-next-line t3code/no-untranslated-copy -- webhook action values, matched literally
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
        {hint ? <span className="font-normal text-2xs text-dim-foreground">{hint}</span> : null}
      </Label>
      {children}
    </div>
  );
}

/** formatRelativeTime handles only the past; upcoming runs need future labels. */
function relativeLabel(value: string | null, nowMs: number, resolve: MessageResolver = m): string {
  if (!value) return resolve(msg("Not scheduled"));
  const diffMs = new Date(value).getTime() - nowMs;
  if (diffMs <= 0) {
    const relative = formatRelativeTime(value, nowMs, resolve);
    if (!relative) return resolve(msg("Not scheduled"));
    return relative.label;
  }
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 2) return resolve(msg("in under a minute"));
  if (minutes < 60) return resolve(msg("in {minutes}m", { minutes }));
  const hours = Math.round(minutes / 60);
  if (hours < 24) return resolve(msg("in {hours}h", { hours }));
  return resolve(msg("in {days}d", { days: Math.round(hours / 24) }));
}

// Use the label's minute tick because the compiler caches render-time Date.now() on the timestamp.
export function ScheduledRelativeLabel(props: { value: string | null }) {
  const messages = useMessages();
  const nowMinute = useNowMinute();
  return relativeLabel(props.value, Date.parse(`${nowMinute}:00.000Z`), messages);
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

const RUN_STATUS_LABELS: Record<ScheduledTask["lastRunStatus"], string> = {
  never: msg("Never run"),
  running: msg("Running", { $context: "scheduled task run status" }),
  succeeded: msg("Succeeded"),
  failed: msg("Failed", { $context: "scheduled task run status" }),
};

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
  const gt = useGT();
  const { scope, environments, connectedEnvironments, environment } = useSettingsScope();
  const [editor, setEditor] = useState<{
    environmentId: EnvironmentId;
    task: ScheduledTask | null;
    template?: Partial<DraftState>;
  } | null>(null);
  const openForEdit = (environmentId: EnvironmentId, task: ScheduledTask) => {
    setEditor({ environmentId, task });
  };
  const openTemplate = (environmentId: EnvironmentId, template: Partial<DraftState>) => {
    setEditor({ environmentId, task: null, template });
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
  const openCreationTemplate = creationEnvironment
    ? (template: Partial<DraftState>) => openTemplate(creationEnvironment.environmentId, template)
    : undefined;
  // New task lives on the first environment group's header; the dialog picks the machine.
  const newTaskButton = (
    <Button
      size="standard"
      variant="secondary"
      disabled={!creationEnvironment}
      onClick={() =>
        creationEnvironment &&
        setEditor({ environmentId: creationEnvironment.environmentId, task: null })
      }
    >
      <PlusIcon className="size-3" />
      <T>New task</T>
    </Button>
  );
  return (
    <SettingsPageContainer className="max-w-[688px]">
      {scope.kind === "unavailable" ? (
        <SettingsSection title={gt("Unavailable selection")}>
          <SettingsRow title={scope.message} />
        </SettingsSection>
      ) : environments.length === 0 ? (
        <SettingsEmptyState
          icon={<Clock3Icon />}
          title={gt("No environments available")}
          description={gt("Connect an environment to manage scheduled tasks.")}
        />
      ) : environments.length > 1 ? (
        <ScheduledTaskEnvironmentList
          environmentId={linkedEnvironmentId}
          taskId={target.taskId}
          onEdit={openForEdit}
          headerAction={newTaskButton}
          onUseTemplate={openCreationTemplate}
        />
      ) : (
        environments.map((entry, index) => (
          <ScheduledTaskEnvironmentSection
            key={entry.environmentId}
            environment={entry}
            headerAction={index === 0 ? newTaskButton : undefined}
            taskId={linkedEnvironmentId === entry.environmentId ? target.taskId : undefined}
            onEdit={openForEdit}
            onUseTemplate={index === 0 ? openCreationTemplate : undefined}
          />
        ))
      )}
      {editor ? (
        <ScheduledTaskEditorDialog
          key={`${editor.environmentId}:${editor.task?.id ?? "new"}`}
          initialEnvironmentId={editor.environmentId}
          task={editor.task}
          template={editor.template}
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
  headerAction,
  onUseTemplate,
}: {
  readonly environmentId: EnvironmentId | undefined;
  readonly taskId: ScheduledTaskId | undefined;
  readonly onEdit: (environmentId: EnvironmentId, task: ScheduledTask) => void;
  readonly headerAction?: ReactNode;
  readonly onUseTemplate?: ((template: Partial<DraftState>) => void) | undefined;
}) {
  const messages = useMessages();
  const gt = useGT();
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
      timeZone: data?.timeZone,
      tasks: data?.tasks.filter((task) =>
        matchesScheduledTaskScope(scope, environment.environmentId, task.projectId),
      ),
      error: query?._tag === "Failure" ? formatEnvironmentQueryError(query.cause, messages) : null,
    };
  });
  const linkedState = states.find((state) => state.environment.environmentId === environmentId);
  const linkedTask = linkedState?.tasks?.find((task) => task.id === taskId);

  const loaded = states.filter((state) => state.connected && state.error === null && state.tasks);
  const populated = loaded.filter((state) => state.tasks && state.tasks.length > 0);
  const loading = states.some((state) => state.connected && state.error === null && !state.tasks);
  // Until one machine has tasks to show, rows stand in for the list instead of a status line.
  const placeholder = loading && populated.length === 0;
  const summaries: Record<string, string[]> = {
    "Not connected:": [],
    "Loading scheduled tasks on": [],
    "Could not load scheduled tasks:": [],
    "No tasks on": [],
  };
  for (const { environment, connected, tasks, error } of states) {
    const label = settingsScopeEnvironmentLabel(environment, environments);
    if (!connected) {
      summaries["Not connected:"]!.push(
        `${label} (${connectionStatusTitle(environment.connection, messages)})`,
      );
    } else if (error !== null) {
      summaries["Could not load scheduled tasks:"]!.push(`${label}: ${error}`);
    } else if (!tasks) {
      if (!placeholder) summaries["Loading scheduled tasks on"]!.push(label);
    } else if (tasks.length === 0 && populated.length > 0) {
      summaries["No tasks on"]!.push(label);
    }
  }

  const templateEnvironment = states[0];
  return (
    <>
      <SettingsSection title={gt("Scheduled tasks")} headerAction={headerAction}>
        {populated.map(({ environment, tasks, timeZone }) => {
          const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
          return (
            <div key={environment.environmentId} className="divide-y divide-border/50">
              <EnvironmentRow
                kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                label={primary}
                subtitle={
                  <ScheduledTaskEnvironmentSubtitle
                    environment={environment}
                    secondary={secondary}
                  />
                }
              >
                <StatusDot
                  size="md"
                  tone={
                    environment.connection.phase === "connected"
                      ? "success"
                      : environment.connection.phase === "connecting" ||
                          environment.connection.phase === "reconnecting"
                        ? "warning"
                        : environment.connection.phase === "error"
                          ? "danger"
                          : "neutral"
                  }
                  label={connectionStatusTitle(environment.connection, messages)}
                />
                <span className="text-caption text-muted-foreground">
                  {connectionStatusTitle(environment.connection, messages)}
                </span>
              </EnvironmentRow>
              {tasks?.map((task) => (
                <ScheduledTaskRow
                  key={task.id}
                  environmentId={environment.environmentId}
                  task={task}
                  timeZone={timeZone}
                  onEdit={() => onEdit(environment.environmentId, task)}
                />
              ))}
            </div>
          );
        })}
        {taskId && linkedState?.tasks && linkedState.error === null && !linkedTask ? (
          <SettingsRow
            title={gt("Task unavailable")}
            description={gt(
              "This task was deleted or belongs to a different project. Check your project filter.",
            )}
            role="status"
          />
        ) : null}
        {placeholder ? (
          <SettingsLoadingRows label={gt("Loading scheduled tasks…")} count={2} />
        ) : null}
        {populated.length === 0 && loaded.length > 0 && !loading ? (
          <SettingsRow
            title={gt("No scheduled tasks")}
            description={gt("No tasks match this environment and project selection.")}
          />
        ) : null}
        {Object.entries(summaries).map(([label, entries]) => {
          if (entries.length === 0) return null;
          const summary = messages(SCOPE_SUMMARY_TEMPLATES[label] ?? label, {
            environments: entries.join(", "),
          });
          return (
            <SharedTooltipTrigger
              key={label}
              render={
                <p
                  className="truncate px-3 py-2.5 text-caption text-muted-foreground sm:px-4"
                  role="status"
                />
              }
              label={summary}
            >
              {summary}
            </SharedTooltipTrigger>
          );
        })}
      </SettingsSection>
      {!loading &&
      templateEnvironment?.connected &&
      templateEnvironment.error === null &&
      templateEnvironment.tasks?.length === 0 &&
      onUseTemplate ? (
        <ScheduledTaskTemplates onUseTemplate={onUseTemplate} />
      ) : null}
    </>
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
  headerAction,
  taskId,
  onEdit,
  onUseTemplate,
}: {
  readonly environment: EnvironmentPresentation;
  readonly headerAction?: ReactNode;
  readonly taskId?: ScheduledTaskId | undefined;
  readonly onEdit: (environmentId: EnvironmentId, task: ScheduledTask) => void;
  /** Set on the first environment: an empty list there also offers the templates. */
  readonly onUseTemplate?: ((template: Partial<DraftState>) => void) | undefined;
}) {
  const gt = useGT();
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
    useMessages(),
  );
  const tasks = tasksQuery.data?.tasks.filter((task) =>
    matchesScheduledTaskScope(scope, environment.environmentId, task.projectId),
  );
  const linkedTask = tasks?.find((task) => task.id === taskId);
  const empty = connected && !tasksQuery.error && tasks?.length === 0;
  return (
    <>
      <SettingsSection
        title={environment.label}
        headerAction={headerAction}
        icon={
          <EnvironmentMachineIcon
            kind={resolveEnvironmentMachineKind(environment.serverConfig)}
            className="size-3.5"
          />
        }
      >
        {!connected ? (
          <SettingsRow
            title={gt("Environment disconnected")}
            description={gt("Reconnect {label} to view its scheduled tasks.", {
              label: environment.label,
            })}
          />
        ) : tasksQuery.error ? (
          <SettingsRow
            title={gt("Could not load scheduled tasks")}
            description={tasksQuery.error}
          />
        ) : !tasks ? (
          <SettingsLoadingRows label={gt("Loading scheduled tasks…")} count={2} />
        ) : (
          <>
            {taskId && !linkedTask ? (
              <SettingsRow
                title={gt("Task unavailable")}
                description={gt(
                  "This task was deleted or belongs to a different project. Check your project filter.",
                )}
                role="status"
              />
            ) : null}
            {tasks.length === 0 ? (
              <div className="py-8">
                <SettingsEmptyState
                  icon={<CalendarClockIcon />}
                  title={gt("No scheduled tasks yet")}
                  description={gt(
                    "A task runs a prompt on a schedule, in a project checkout or a new worktree, and shows up in the sidebar as a thread when it runs.",
                  )}
                />
              </div>
            ) : (
              tasks.map((task) => (
                <ScheduledTaskRow
                  key={task.id}
                  environmentId={environment.environmentId}
                  task={task}
                  timeZone={tasksQuery.data?.timeZone}
                  onEdit={() => onEdit(environment.environmentId, task)}
                />
              ))
            )}
          </>
        )}
      </SettingsSection>
      {empty && onUseTemplate ? <ScheduledTaskTemplates onUseTemplate={onUseTemplate} /> : null}
    </>
  );
}

function ScheduledTaskTemplates({
  onUseTemplate,
}: {
  readonly onUseTemplate: (template: Partial<DraftState>) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  return (
    <>
      <SettingsEmptyTiles title={gt("Start from an example")}>
        {TASK_TEMPLATES.map((template) => (
          <SettingsEmptyTile
            key={template.title}
            icon={<template.icon />}
            title={messages(template.title)}
            description={messages(template.description)}
            aside={<Badge variant="secondary">{messages(template.badge)}</Badge>}
          >
            <span className="mt-2 flex">
              <Button
                size="xs"
                variant="ghost"
                className="-ml-2"
                onClick={() =>
                  onUseTemplate({
                    ...template.draft,
                    title: messages(template.title),
                    prompt: template.description,
                  })
                }
              >
                <T>Use template</T>
                <ArrowRightIcon />
              </Button>
            </span>
          </SettingsEmptyTile>
        ))}
      </SettingsEmptyTiles>
      <SettingsEmptyTiles title={gt("How a run works")}>
        <SettingsEmptyTile
          icon={<AlarmClockIcon />}
          title={gt("On schedule")}
          description={gt("The task starts at its time, even if the window is closed.")}
        />
        <SettingsEmptyTile
          icon={<GitBranchIcon />}
          title={gt("In its workspace")}
          description={gt("A project checkout or a fresh worktree, with the model you chose.")}
        />
        <SettingsEmptyTile
          icon={<MessageSquareIcon />}
          title={gt("As a thread")}
          description={gt("It lands in the sidebar marked Scheduled, like any other run.")}
        />
      </SettingsEmptyTiles>
    </>
  );
}

function ScheduledTaskRow({
  environmentId,
  task,
  timeZone,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly timeZone: string | undefined;
  readonly onEdit: () => void;
}) {
  const messages = useMessages();
  const locale = useLocale();
  const gt = useGT();
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
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
    if (action === "delete") {
      const message = `${gt('Delete "{title}"?', { title: task.title })}\n${gt("This cannot be undone.")}`;
      const confirmed =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      if (!confirmed) return;
    }
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
          title: gt("Could not update scheduled task"),
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
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>
            {scheduleLabel(
              task.schedule,
              timestampFormat,
              timeZone,
              task.nextRunAt,
              messages,
              locale,
            )}
          </span>
          <span>
            {task.blockedByPolicy !== undefined ? (
              task.blockedByPolicy
            ) : !task.enabled ? (
              gt("Paused")
            ) : isWebhook ? (
              gt("Listening")
            ) : task.nextRunAt ? (
              <T>
                Next run <ScheduledRelativeLabel value={task.nextRunAt} />
              </T>
            ) : (
              gt("Not scheduled")
            )}
          </span>
          {task.lastRunStatus !== "never" ? (
            <Badge variant={statusVariant(task.lastRunStatus)}>
              {messages(RUN_STATUS_LABELS[task.lastRunStatus])}
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
            aria-label={gt("Enable {title}", { title: task.title })}
            onCheckedChange={() => void act("toggle")}
          />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy || !canOperate}
                  aria-label={gt("Actions for {title}", { title: task.title })}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={onEdit}>
                <PencilIcon />
                <T>Edit</T>
              </MenuItem>
              {isWebhook ? (
                <MenuItem onClick={() => setDeliveriesOpen(true)}>
                  <InboxIcon />
                  <T>Deliveries</T>
                </MenuItem>
              ) : (
                <MenuItem onClick={() => void act("run")}>
                  <PlayIcon />
                  <T>Run now</T>
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem onClick={() => void act("delete")}>
                <Trash2Icon />
                <T context="verb, delete the scheduled task">Delete</T>
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
  const gt = useGT();
  const ref = scopeThreadRef(environmentId, threadId);
  const title = useQuietThreadShell(ref)?.title.trim();
  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(ref)}
      className="max-w-64 truncate underline underline-offset-2 hover:text-foreground"
    >
      {title || gt("Open thread")}
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
  const messages = useMessages();
  const gt = useGT();
  const deliveriesQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTaskWebhookDeliveries({
      environmentId,
      input: { id: task.id, acceptAnyOutcome: true },
    }),
    messages,
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
    messages,
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
            <T>Deliveries</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              <Var>{task.title}</Var>. Recent requests to this task's webhook URL.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {selectedId !== null && selected === null && selectedQuery.error === null ? (
            <p className="text-sm text-muted-foreground" role="status">
              <T>Loading delivery…</T>
            </p>
          ) : selected ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge
                  variant={deliveryOutcomeVariant(
                    selected.pendingWindow ? "coalesced" : selected.outcome,
                  )}
                >
                  {webhookDeliveryLabel(selected, messages)}
                </Badge>
                <span className="grid gap-1">
                  <span>{selected.method}</span>
                  <span>
                    <ScheduledRelativeLabel value={selected.receivedAt} />
                  </span>
                </span>
                {selected.signatureVerified ? (
                  <span className="text-muted-foreground">
                    <T>Signature verified</T>
                  </span>
                ) : null}
              </div>
              {selected.error ? (
                <p
                  className={
                    selected.outcome === "filtered"
                      ? "text-body text-muted-foreground"
                      : "text-body text-error-foreground"
                  }
                >
                  {selected.error}
                </p>
              ) : null}
              <DeliveryBlock
                title={
                  selected.pendingWindow ? gt("Scheduled run") : gt("Prompt sent to the agent")
                }
              >
                {selected.renderedPrompt ??
                  (selected.pendingWindow
                    ? gt("Run scheduled when the window closes; no run started yet.")
                    : gt("No run was started for this request."))}
              </DeliveryBlock>
              {selected.missingFields.length > 0 ? (
                <p className="text-sm text-muted-foreground">
                  {gt("Empty placeholders: {fields}", {
                    fields: selected.missingFields.join(", "),
                  })}
                </p>
              ) : null}
              <DeliveryBlock title={gt("Headers")}>
                {Object.entries(selected.headers)
                  .map(([name, value]) => `${name}: ${value}`)
                  .join("\n")}
              </DeliveryBlock>
              {selected.query ? (
                <DeliveryBlock title={gt("Query")}>{selected.query}</DeliveryBlock>
              ) : null}
              <DeliveryBlock title={selected.bodyTruncated ? gt("Body (truncated)") : gt("Body")}>
                {selected.body || gt("(empty)")}
              </DeliveryBlock>
            </div>
          ) : selectedId !== null ? null : deliveries === null ? (
            <p className="text-body text-muted-foreground" role="status">
              <T>Loading deliveries…</T>
            </p>
          ) : deliveries.length === 0 ? (
            <p className="text-body text-muted-foreground">
              <T>No requests yet.</T>
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {deliveries.map((delivery) => (
                <li key={delivery.id}>
                  <Button
                    variant="ghost"
                    size="sm-multiline"
                    className="w-full flex-wrap justify-start text-left"
                    onClick={() => setSelectedId(delivery.id)}
                  >
                    <Badge
                      variant={deliveryOutcomeVariant(
                        delivery.pendingWindow ? "coalesced" : delivery.outcome,
                      )}
                    >
                      {webhookDeliveryLabel(delivery, messages)}
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
                        {gt(
                          "{count, plural, one {{count} empty placeholder} other {{count} empty placeholders}}",
                          { count: delivery.missingFields.length },
                        )}
                      </span>
                    ) : null}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter>
          {selectedId !== null ? (
            <Button variant="secondary" size="sm" onClick={() => setSelectedId(null)}>
              <T>Back</T>
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              disabled={deliveriesQuery.isPending}
              onClick={deliveriesQuery.refresh}
            >
              <T>Refresh</T>
            </Button>
          )}
          <DialogClose render={<Button size="sm" />}>
            <T>Done</T>
          </DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DeliveryBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label>{title}</Label>
      <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-meta whitespace-pre-wrap break-all">
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
  const gt = useGT();
  const messages = useMessages();
  const canRotate = useAtomValue(
    serverEnvironment.rotateScheduledTaskWebhookToken.permissionAtom(environmentId),
  );
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: {
      target: "webhook URL",
      unavailableMessage: msg("Clipboard API is unavailable while copying webhook URL."),
      failureMessage: msg("Failed to copy webhook URL to the clipboard."),
    },
  });
  const rotate = useAtomCommand(serverEnvironment.rotateScheduledTaskWebhookToken, {
    label: "scheduled task rotate webhook token",
  });
  const [rotating, setRotating] = useState(false);
  const endpoint = task?.webhook;
  if (!task || !endpoint) {
    return (
      <p className="text-body text-muted-foreground">
        <T>The URL appears after you save.</T>
      </p>
    );
  }
  const { address: url, copyable, note } = webhookAddress(endpoint, httpBaseUrl, messages);
  const rotateUrl = async () => {
    const confirmed =
      (await requestConfirmDialog(
        `${gt("Rotate this webhook URL?")}\n${gt("The current URL stops working.")}`,
        {
          variant: "destructive",
        },
      )) ?? window.confirm(gt("Rotate this webhook URL? The current URL stops working."));
    if (!confirmed) return;
    setRotating(true);
    const result = await rotate({ environmentId, input: { id: task.id } });
    setRotating(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not rotate webhook URL"),
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
          aria-label={gt("Webhook URL")}
          value={url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button
          size="sm"
          variant="secondary"
          type="button"
          disabled={!copyable}
          onClick={() => copyToClipboard(url, undefined)}
        >
          <CopyIcon />
          {isCopied ? gt("Copied") : gt("Copy")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          type="button"
          disabled={rotating || !canRotate}
          onClick={() => void rotateUrl()}
        >
          <T>Rotate</T>
        </Button>
      </div>
      {note !== null ? <p className="text-meta text-muted-foreground">{note}</p> : null}
      {endpoint.url !== null ? <WebhookDeliveryMode environmentId={environmentId} /> : null}
    </div>
  );
}

function WebhookDeliveryMode({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const cloudLink = usePrimaryCloudLinkState();
  if (cloudLink.target?.environmentId !== environmentId || cloudLink.data === null) return null;
  return (
    <p className="text-meta text-muted-foreground">
      {cloudLink.data.holdWebhooksWhileOffline
        ? gt("Held for up to 24 hours while this environment is offline. ")
        : gt("Forwarded live. Requests fail while this environment is offline. ")}
      <Link to="/settings/access" className="underline underline-offset-2">
        <T>Change in Sharing & access</T>
      </Link>
    </p>
  );
}

function ScheduledTaskEditorDialog({
  initialEnvironmentId,
  task,
  template,
  onClose,
}: {
  readonly initialEnvironmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
  readonly template?: Partial<DraftState> | undefined;
  readonly onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  return (
    <Dialog
      open
      // A stray click outside would discard the unsaved draft; Escape and Cancel still close it.
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      {/* The form owns the draft so a keystroke re-renders it, not the dialog chrome. */}
      <DialogPopup className="max-w-xl">
        <ScheduledTaskEditorForm
          initialEnvironmentId={initialEnvironmentId}
          task={task}
          template={template}
          saving={saving}
          onSavingChange={setSaving}
          onClose={onClose}
        />
      </DialogPopup>
    </Dialog>
  );
}

const THREAD_MODE_LABELS: Record<ScheduledTaskThreadMode, string> = {
  new_thread: msg("New thread each run"),
  continue: msg("One thread, continuing the conversation"),
  fresh_session: msg("One thread, fresh session each run"),
};

function useScheduledTaskThread(environmentId: EnvironmentId, threadId: ThreadId | null) {
  const ref = threadId === null ? null : scopeThreadRef(environmentId, threadId);
  const shell = useThreadShell(ref);
  // The shell can omit older settled threads; their family read still carries the row.
  const family = useEnvironmentQuery(
    ref !== null && shell === null ? threadFamilies.familyAtom(environmentId, ref.threadId) : null,
  );
  return shell ?? family.data?.threads.find((row) => row.id === threadId) ?? null;
}

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
  const messages = useMessages();
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = threadId === null ? null : scopeThreadRef(environmentId, threadId);
  const thread = useScheduledTaskThread(environmentId, threadId);
  const currentLabel =
    ref !== null
      ? thread?.title.trim() || gt("Thread {id}", { id: ref.threadId })
      : threadMode === "new_thread"
        ? gt("New thread each run")
        : gt("Started by the first run");
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
      ? gt("Each run starts a new thread with the workspace and model below.")
      : ref === null
        ? threadMode === "continue"
          ? gt(
              "The first run starts a thread with the workspace and model below. Later runs continue that conversation.",
            )
          : gt(
              "The first run starts a thread with the workspace and model below. Later runs post there, each in a fresh session without earlier runs' context.",
            )
        : threadMode === "continue"
          ? gt("Each run continues this conversation, in its workspace and with its current model.")
          : gt("Each run starts a fresh session in this thread, without earlier runs' context.");
  return (
    <Field label={gt("Destination")} htmlFor="scheduled-task-destination">
      {onThreadModeChange ? (
        <Select
          value={threadMode}
          onValueChange={(value) => onThreadModeChange(value as ScheduledTaskThreadMode)}
        >
          <SelectTrigger size="sm" id="scheduled-task-destination">
            <SelectValue>{messages(THREAD_MODE_LABELS[threadMode])}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {(Object.keys(THREAD_MODE_LABELS) as ScheduledTaskThreadMode[]).map((mode) => (
              <SelectItem key={mode} value={mode}>
                {messages(THREAD_MODE_LABELS[mode])}
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
            aria-label={onThreadModeChange ? gt("Destination thread") : undefined}
            disabled={disabled}
            render={<Button variant="secondary" size="sm" />}
            className="w-full justify-between"
          >
            <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-left">{currentLabel}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </ComboboxTrigger>
          <ComboboxPopup align="start" side="bottom" className="w-80">
            <ComboboxSearchInput
              aria-label={gt("Search threads")}
              placeholder={gt("Search all threads...")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <ComboboxEmpty>
              <T>No threads found.</T>
            </ComboboxEmpty>
            <ComboboxList scrollAreaClassName="max-h-72">
              {items.map((value, index) => (
                <ComboboxItem key={value} index={index} value={value}>
                  <span className="block truncate">
                    {value === NEW_THREAD_DESTINATION
                      ? gt("New thread each run")
                      : value === threadId
                        ? currentLabel
                        : threads.find((row) => row.id === value)?.title || gt("Untitled thread")}
                  </span>
                </ComboboxItem>
              ))}
            </ComboboxList>
          </ComboboxPopup>
        </Combobox>
      ) : null}
      <div className="space-y-1 text-body">
        <p className="text-muted-foreground">{detail}</p>
        {threadMode !== "new_thread" ? (
          <p className="text-muted-foreground">
            <T>Deleting the thread also deletes this task.</T>
          </p>
        ) : null}
      </div>
    </Field>
  );
}

function ScheduledTaskEditorForm({
  initialEnvironmentId,
  task,
  template,
  saving,
  onSavingChange: setSaving,
  onClose,
}: {
  readonly initialEnvironmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
  readonly template?: Partial<DraftState> | undefined;
  readonly saving: boolean;
  readonly onSavingChange: (saving: boolean) => void;
  readonly onClose: () => void;
}) {
  const messages = useMessages();
  const locale = useLocale();
  const gt = useGT();
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
    messages,
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
  const webhookDenial = managedCapabilityDenial(
    useManagedPolicy(environmentId),
    "webhookTasks",
    messages,
  );
  const [draft, setDraft] = useState<DraftState>(() =>
    task
      ? taskToDraft(task)
      : {
          ...EMPTY_DRAFT,
          ...template,
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
  const runAtZone = scheduleTimeZoneLabel(tasksQuery.data?.timeZone);
  const liveTask = tasksQuery.data
    ? (tasksQuery.data.tasks.find((entry) => entry.id === draft.editingId) ?? null)
    : task;
  const selectedProjectId = draft.projectId || projects[0]?.id || "";
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const automaticBaseRef =
    draft.workspaceMode === "worktree" && !trimAsciiWhitespace(draft.baseRef);
  const automaticBaseRefs = usePaginatedBranches({
    environmentId,
    cwd: automaticBaseRef ? (selectedProject?.workspaceRoot ?? null) : null,
    query: "",
  });
  const worktreeBaseRef = scheduledTaskWorktreeBaseRef(draft.baseRef, automaticBaseRefs.refs);
  // Until the project's refs load, the automatic base would save as `main`. A failed lookup falls back to it.
  const automaticBaseRefLoading =
    automaticBaseRef &&
    selectedProject !== undefined &&
    automaticBaseRefs.data === null &&
    automaticBaseRefs.error === null;
  const instanceEntries = providerInstanceEntriesFor(
    providers,
    settings,
    selectedProject?.id ?? null,
  );

  const firstInstance = instanceEntries[0];
  const draftSelection = draft.modelSelection;
  const activeSelection =
    draftSelection &&
    instanceEntries.some((entry) => entry.instanceId === draftSelection.instanceId && entry.enabled)
      ? draftSelection
      : scheduledTaskDefaultModel(settings, selectedProject ?? null, instanceEntries);
  const activeInstanceId =
    activeSelection?.instanceId ?? firstInstance?.instanceId ?? ("" as ProviderInstanceId);
  const activeModel = activeSelection?.model ?? "";
  const boundThread = useScheduledTaskThread(
    environmentId,
    draft.threadId ? (draft.threadId as ThreadId) : null,
  );
  // Bound runs use the thread's current model, so the locked picker shows that one.
  const shownSelection = draft.threadId
    ? (boundThread?.modelSelection ?? null)
    : { instanceId: activeInstanceId, model: activeModel };
  const shownInstanceId = shownSelection?.instanceId ?? activeInstanceId;
  const shownModel = shownSelection?.model ?? "";
  const activeEntry = instanceEntries.find((entry) => entry.instanceId === activeInstanceId);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    shownInstanceId,
    shownModel,
  );

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description:
          error instanceof Error ? (thrownErrorMessage(error, m) ?? error.message) : String(error),
      }),
    );
  };

  const canSubmit =
    canOperate &&
    !saving &&
    !editingTaskMissing &&
    connected &&
    Boolean(tasksQuery.data) &&
    !automaticBaseRefLoading &&
    !(draft.enabled && draft.scheduleMode === "webhook" && webhookDenial !== undefined);

  const submit = async () => {
    if (
      !canSubmit ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      submissionPending.current
    )
      return;
    const selection = activeSelection;
    if (
      !draft.title.trim() ||
      !draft.prompt.trim() ||
      !projects.some((project) => project.id === selectedProjectId) ||
      selection === null
    ) {
      reportFailure(
        gt("Scheduled task is incomplete"),
        gt("Add a title, prompt, project, and model."),
      );
      return;
    }
    const parsedFilters = parseWebhookFilterDrafts(draft.filters, m);
    if (draft.scheduleMode === "webhook" && "error" in parsedFilters) {
      reportFailure(gt("Invalid filter"), parsedFilters.error);
      return;
    }
    const schedule = scheduleFromDraft(draft);
    if (schedule === null) {
      for (const error of scheduleDraftErrors(draft)) reportFailure(error.title, error.description);
      return;
    }
    if (
      schedule.type === "webhook" &&
      schedule.signature &&
      (!schedule.signature.header ||
        (!schedule.signature.secret &&
          !(liveTask?.schedule.type === "webhook" && liveTask.webhook?.hasSecret)))
    ) {
      reportFailure(gt("Signing secret is required"), gt("Enter the signature header and secret."));
      return;
    }
    if (
      schedule.type === "interval" &&
      (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS)
    ) {
      reportFailure(gt("Invalid interval"), gt("Enter an interval of at least one minute."));
      return;
    }
    if (schedule.type === "once" && !offersOnce) {
      reportFailure(
        gt("Once is not available here"),
        gt(
          "This environment runs an older T3 Code. Update it to schedule a one-time task, or pick another schedule.",
        ),
      );
      return;
    }
    if (draft.workspaceMode === "existing_worktree" && !draft.existingWorktreePath.trim()) {
      reportFailure(
        gt("Checkout path is required"),
        gt("Enter the path of the checkout to run in."),
      );
      return;
    }
    const workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy =
      draft.workspaceMode === "root"
        ? { type: "root" }
        : draft.workspaceMode === "existing_worktree"
          ? { type: "existing_worktree", worktreePath: draft.existingWorktreePath.trim() }
          : {
              type: "worktree",
              baseRef: worktreeBaseRef,
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
      ...(draft.threadId === "" && draft.savedThreadId !== "" ? { unbindThread: true } : {}),
      ...(offersThreadModes ? { threadMode: draft.threadMode } : {}),
      workspaceStrategy,
      modelSelection: selection,
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
        reportFailure(gt("Could not save scheduled task"), squashAtomCommandFailure(result));
      }
      return;
    }
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {draft.editingId ? gt("Edit scheduled task") : gt("New scheduled task")}
        </DialogTitle>
      </DialogHeader>

      <DialogPanel>
        <fieldset
          disabled={saving}
          className="min-w-0 space-y-4"
          onKeyDown={(event) => {
            // ⌘⏎ / Ctrl+Enter saves from any field, as the footer hint shows.
            if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
            event.preventDefault();
            if (canSubmit) void submit();
          }}
        >
          {!connected ? (
            <p className="text-body text-destructive">
              <T>Reconnect this environment before saving.</T>
            </p>
          ) : null}
          {tasksQuery.error ? (
            <p className="text-body text-destructive" role="status">
              {tasksQuery.error}
            </p>
          ) : null}
          {editingTaskMissing ? (
            <p className="text-meta text-destructive" role="status">
              <T>This scheduled task no longer exists.</T>
            </p>
          ) : null}
          <Field label={gt("Name")} htmlFor="scheduled-task-title">
            <Input
              id="scheduled-task-title"
              placeholder={gt("e.g. Check for Sentry issues")}
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

          <Field label={gt("Prompt")} htmlFor="scheduled-task-prompt">
            <Textarea
              id="scheduled-task-prompt"
              className="max-h-40 overflow-y-auto"
              placeholder={gt("What should the agent do each time this runs?")}
              value={draft.prompt}
              onChange={(event) =>
                setDraft((current) => ({ ...current, prompt: event.target.value }))
              }
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={gt("Project")} htmlFor="scheduled-task-project">
              <Select
                value={selectedProjectId}
                onValueChange={(projectId) =>
                  setDraft((current) => changeDraftProject(current, projectId ?? ""))
                }
              >
                <SelectTrigger size="sm" id="scheduled-task-project">
                  <SelectValue placeholder={gt("Select a project")}>
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
                        <span className="block max-w-72 truncate text-caption text-muted-foreground">
                          {project.workspaceRoot}
                        </span>
                      ) : null}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            <Field label={gt("Runs on")} htmlFor="scheduled-task-environment">
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
                    modelSelection: null,
                    baseRef: "",
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
                      {environment?.label ?? gt("Unavailable environment")}
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
                              <span className="block max-w-72 truncate text-caption text-muted-foreground">
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
          </div>

          <Field label={gt("Workspace")}>
            <ToggleGroup
              aria-label={gt("Workspace")}
              className="w-full *:flex-1"
              value={[draft.workspaceMode]}
              onValueChange={(values) => {
                const value = values[0];
                if (value === "root" || value === "worktree" || value === "existing_worktree")
                  setDraft((current) => ({ ...current, workspaceMode: value }));
              }}
            >
              <Toggle value="root">
                <T>Project checkout</T>
              </Toggle>
              <Toggle value="worktree">
                <T>New worktree</T>
              </Toggle>
              <Toggle value="existing_worktree">
                <T>Specific checkout</T>
              </Toggle>
            </ToggleGroup>
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            {draft.workspaceMode === "worktree" ? (
              <Field label={gt("Base branch")} htmlFor="scheduled-task-base-ref">
                <WorktreeBaseBranchPicker
                  key={`${environmentId}:${selectedProjectId}`}
                  id="scheduled-task-base-ref"
                  environmentId={environmentId}
                  cwd={selectedProject?.workspaceRoot ?? null}
                  value={automaticBaseRefLoading ? "" : worktreeBaseRef}
                  onValueChange={(baseRef) => setDraft((current) => ({ ...current, baseRef }))}
                  startFromOrigin={draft.startFromOrigin}
                  onStartFromOriginChange={(startFromOrigin) =>
                    setDraft((current) => ({ ...current, startFromOrigin }))
                  }
                  disabled={saving || !connected}
                />
              </Field>
            ) : draft.workspaceMode === "existing_worktree" ? (
              <Field label={gt("Checkout path")} htmlFor="scheduled-task-checkout">
                <Input
                  id="scheduled-task-checkout"
                  size="sm"
                  font="mono"
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
            <Field label={gt("Model")}>
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <ProviderModelPicker
                  environmentId={environmentId}
                  // The saved selection only seeds new threads; bound runs ignore it.
                  disabled={saving || !connected || draft.threadId !== ""}
                  activeInstanceId={shownInstanceId}
                  model={shownModel}
                  lockedProvider={null}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  isComposerOwned={false}
                  triggerVariant="settings"
                  triggerClassName="min-w-0 max-w-full flex-1 text-left sm:max-w-full"
                  onInstanceModelChange={(instanceId, model) => {
                    if (
                      instanceId === activeSelection?.instanceId &&
                      model === activeSelection.model
                    )
                      return;
                    setDraft((current) => ({
                      ...current,
                      modelSelection: createModelSelection(instanceId, model),
                    }));
                  }}
                />
                {!draft.threadId && activeSelection && activeEntry ? (
                  <TraitsPicker
                    provider={activeEntry.driverKind}
                    models={activeEntry.models}
                    model={activeModel}
                    modelOptions={activeSelection.options ?? []}
                    allowPromptInjectedEffort={false}
                    includePlanAgent={selectsPlanAgent(activeSelection.options)}
                    disabled={saving || !connected}
                    triggerVariant="settings"
                    triggerClassName="shrink-0"
                    onModelOptionsChange={(options) =>
                      setDraft((current) => ({
                        ...current,
                        modelSelection: createModelSelection(
                          activeInstanceId,
                          activeModel,
                          options,
                        ),
                      }))
                    }
                  />
                ) : null}
              </div>
            </Field>
          </div>

          <div className="space-y-3">
            {task?.schedule.type === "interval" &&
            task.schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS ? (
              <p className="text-body text-muted-foreground" role="status">
                <T>
                  This task uses a legacy interval below one minute. Saving updates it to at least
                  one minute.
                </T>
              </p>
            ) : null}
            <Field label={gt("Schedule")}>
              <ToggleGroup
                aria-label={gt("Schedule type")}
                className="w-full *:flex-1"
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
                <Toggle value="fixed">
                  <T>At a time</T>
                </Toggle>
                {offersOnce || draft.scheduleMode === "once" ? (
                  <Toggle value="once">
                    <T>Once</T>
                  </Toggle>
                ) : null}
                <Toggle value="interval">
                  <T>Every interval</T>
                </Toggle>
                <Toggle
                  value="webhook"
                  disabled={webhookDenial !== undefined && draft.scheduleMode !== "webhook"}
                >
                  <T>On webhook</T>
                </Toggle>
              </ToggleGroup>
            </Field>

            {webhookDenial !== undefined ? (
              <ManagedNotice>
                {draft.scheduleMode === "webhook"
                  ? gt(
                      "{webhookDenial} Switch this task to a time or an interval, or turn it off, to save it.",
                      { webhookDenial },
                    )
                  : webhookDenial}
              </ManagedNotice>
            ) : null}
            {/* A disabled task still saves, so keep its fields reachable for fixing. */}
            {draft.scheduleMode === "webhook" &&
            webhookDenial !== undefined &&
            draft.enabled ? null : draft.scheduleMode === "webhook" ? (
              <div className="space-y-4">
                <WebhookEndpointField environmentId={environmentId} task={liveTask} />
                <p className="text-meta text-muted-foreground">
                  {gt(
                    "Each request runs the prompt. Use {bodyPath}, {headerName}, {queryName}, {body} or {request} in the prompt; only what it names reaches the agent.",
                    {
                      bodyPath: "{{body.path}}",
                      headerName: "{{headers.name}}",
                      queryName: "{{query.name}}",
                      body: "{{body}}",
                      request: "{{request}}",
                    },
                  )}
                </p>
                <Field
                  label={gt("Skip requests older than")}
                  hint={gt("minutes, optional")}
                  htmlFor="scheduled-task-max-age"
                >
                  <Input
                    id="scheduled-task-max-age"
                    type="number"
                    nativeInput
                    min={1}
                    max={MAX_WEBHOOK_DELIVERY_AGE_MINUTES}
                    placeholder={gt("Run every request")}
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
                  label={gt("Duplicate request key")}
                  hint={gt("template, optional")}
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
                <p className="text-meta text-muted-foreground">
                  <T>Requests with the same key run only once within 7 days.</T>
                </p>
                <Field
                  label={gt("Coalesce key")}
                  hint={gt("template, optional")}
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
                  label={gt("Coalesce window")}
                  hint={gt("seconds, 10–3600")}
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
                <p className="text-meta text-muted-foreground">
                  <T>
                    Coalescing runs the latest payload once when the window from the first delivery
                    closes. Empty keys run normally.
                  </T>
                </p>
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 space-y-1">
                    <Label htmlFor="scheduled-task-signature">
                      <T>Require signature</T>
                    </Label>
                    <p className="text-body text-muted-foreground">
                      <T>Reject requests without a valid HMAC-SHA256 signature of the body.</T>
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
                    <Field label={gt("Header")} htmlFor="scheduled-task-signature-header">
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
                    <Field label={gt("Prefix")} htmlFor="scheduled-task-signature-prefix">
                      <Input
                        id="scheduled-task-signature-prefix"
                        value={draft.signaturePrefix}
                        placeholder={gt("None")}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            signaturePrefix: event.target.value,
                          }))
                        }
                      />
                    </Field>
                    <Field label={gt("Encoding")} htmlFor="scheduled-task-signature-encoding">
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
                    <Field label={gt("Secret")} htmlFor="scheduled-task-signature-secret">
                      <Input
                        id="scheduled-task-signature-secret"
                        type="password"
                        autoComplete="off"
                        value={draft.signatureSecret}
                        placeholder={
                          liveTask?.schedule.type === "webhook" && liveTask.webhook?.hasSecret
                            ? gt("Unchanged")
                            : gt("Shared secret")
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
              <Field label={gt("Run on")} htmlFor="scheduled-task-run-at">
                <Input
                  type="datetime-local"
                  id="scheduled-task-run-at"
                  nativeInput
                  value={draft.runAt}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, runAt: event.target.value }))
                  }
                />
                <p className="text-meta text-muted-foreground">
                  <T>Uses your time zone.</T>
                </p>
              </Field>
            ) : draft.scheduleMode === "fixed" ? (
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-0 flex-1">
                  <Field label={gt("Days")}>
                    <ToggleGroup
                      multiple
                      detached={true}
                      variant="outline"
                      size="sm"
                      aria-label={gt("Days to run")}
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
                        <Toggle
                          key={day}
                          value={String(day)}
                          aria-label={weekdayShortLabel(day, locale)}
                        >
                          {weekdayShortLabel(day, locale)}
                        </Toggle>
                      ))}
                    </ToggleGroup>
                  </Field>
                </div>
                <Field label={gt("Run at")} htmlFor="scheduled-task-time">
                  <div className="flex items-center gap-2">
                    <Input
                      type="time"
                      id="scheduled-task-time"
                      aria-describedby={
                        runAtZone === undefined ? undefined : "scheduled-task-time-zone"
                      }
                      nativeInput
                      size="sm"
                      className="w-32"
                      value={draft.timeOfDay}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, timeOfDay: event.target.value }))
                      }
                    />
                    {runAtZone === undefined ? null : (
                      <span
                        id="scheduled-task-time-zone"
                        className="text-meta text-muted-foreground"
                      >
                        {runAtZone}
                      </span>
                    )}
                  </div>
                </Field>
              </div>
            ) : (
              <Field label={gt("Run every")} htmlFor="scheduled-task-interval">
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    id="scheduled-task-interval"
                    nativeInput
                    size="sm"
                    min={1}
                    step="any"
                    className="w-24"
                    value={draft.intervalMinutes}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, intervalMinutes: event.target.value }))
                    }
                  />
                  <span className="text-meta text-muted-foreground">
                    {gt("{count, plural, one {minute} other {minutes}}", {
                      count: Number(draft.intervalMinutes),
                    })}
                  </span>
                </div>
              </Field>
            )}
          </div>
        </fieldset>
      </DialogPanel>

      <DialogFooter className="sm:justify-between">
        <label className="flex items-center gap-2 text-body text-muted-foreground">
          <Switch
            id="scheduled-task-enabled"
            aria-label={gt("Enabled")}
            disabled={saving}
            checked={draft.enabled}
            onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
          />
          <T>Enabled</T>
        </label>
        <div className="flex gap-2">
          <DialogClose render={<Button variant="secondary" disabled={saving} />}>
            <T>Cancel</T>
          </DialogClose>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            {draft.editingId ? gt("Save task") : gt("Create task")}
            <Kbd>{isMacPlatform(navigator.platform) ? "\u2318\u23ce" : "Ctrl \u23ce"}</Kbd>
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
