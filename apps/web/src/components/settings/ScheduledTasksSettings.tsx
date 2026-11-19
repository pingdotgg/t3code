import { weekdayShortLabel } from "./scheduledTasksSettings.logic";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { managedCapabilityDenial } from "@t3tools/client-runtime/contract-labels";
import { useAtomValue } from "@effect/atom-react";
import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import { AsyncResult } from "effect/reactivity";
import {
  ArchiveRestoreIcon,
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
  McpGatewayProfile,
  ModelSelection,
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
import { scheduledTaskDestinationThreads } from "@t3tools/client-runtime/scheduled-task-destinations";
import {
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
import { msg, T, useGT, useLocale, useMessages, Var } from "gt-react";
import { m, type MessageResolver } from "../../i18n/messages";

import { formatRelativeTime } from "../../timestampFormat";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { requestConfirmDialog } from "../../confirmDialog";
import { webhookAddress } from "@t3tools/client-runtime/webhook-address";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNowMinute } from "../../hooks/useNowMinute";
import {
  useEnvironment,
  useEnvironmentHttpBaseUrl,
  useEnvironmentProviders,
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
import { AuthOrchestrationOperateScope, clampManagedRuntimeMode } from "@t3tools/contracts";
import { resolvePastedPath } from "@t3tools/shared/path";
import {
  isScheduledTaskArchived,
  SCHEDULED_TASK_FILTERS,
  scheduledTaskArchiveLabel,
  scheduledTaskMatchesFilter,
  scheduledTaskRestoreNeedsEditor,
  type ScheduledTaskFilter,
} from "@t3tools/client-runtime/scheduled-task-archive";
import {
  localTimeZone,
  repeatFormToCron,
  WEEKDAY_NAMES,
  type RepeatForm,
  type RepeatPreset,
} from "@t3tools/client-runtime/scheduled-task-cron";
import { useAgentLibrary } from "~/hooks/useAgentLibrary";
import { agentMachineUnavailableReason } from "../agents/agentMachineAvailability";
import { useManagedPolicy } from "~/state/managedPolicy";
import { ManagedNotice } from "../ManagedPolicy";
import { readEnvironmentScope } from "~/state/session";
import { useSettingsScope } from "./SettingsScopeContext";
import { EnvironmentRow, useEnvironmentTransportLabel } from "./EnvironmentRow";
import { SettingsGroup } from "./SettingsGroup";
import { settingsScopeEnvironmentLabel, settingsScopeEnvironmentLabels } from "./settingsScopeAxis";
import {
  DEFAULT_CRON_FORM,
  WEBHOOK_SIGNATURE_DEFAULTS,
  changeDraftProject,
  moveDraftOffAgent,
  moveDraftToAgent,
  moveDraftToThread,
  scheduledTaskDraftRouting,
  scheduleDraftErrors,
  toDateTimeLocalValue,
  webhookDeliveryLabel,
  defaultScheduledTaskProjectId,
  matchesScheduledTaskScope,
  newScheduledTaskEnvironment,
  scheduleFromDraft,
  scheduleLabel,
  scheduledTaskDefaultModel,
  scheduledTaskDeletesLabel,
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
import { useSearchableSetting } from "./settingsSearch";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
} from "./settingsLayout";
import { APP_NAME } from "@t3tools/shared/branding";

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_SHORT = [
  msg("Su", { $context: "two-letter Sunday" }),
  msg("Mo", { $context: "two-letter Monday" }),
  msg("Tu", { $context: "two-letter Tuesday" }),
  msg("We", { $context: "two-letter Wednesday" }),
  msg("Th", { $context: "two-letter Thursday" }),
  msg("Fr", { $context: "two-letter Friday" }),
  msg("Sa", { $context: "two-letter Saturday" }),
] as const;

// Thread ids are trimmed, so the leading space keeps this from matching one.
const NEW_THREAD_DESTINATION = " new-thread";

const REPEAT_PRESETS: Record<RepeatPreset, string> = {
  daily: "Every day",
  weekdays: "Weekdays",
  weekly: "Every week",
  hourly: "Every hour",
  custom: "Custom (cron)",
};

const WORKSPACE_MODE_LABELS: Record<WorkspaceMode, string> = {
  worktree: msg("Create a new worktree"),
  root: msg("Use the project checkout"),
  existing_worktree: msg("Use a specific checkout"),
};

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
  cron: DEFAULT_CRON_FORM,
  cronTimezone: "",
  projectId: "",
  threadId: "",
  profileId: "",
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
          <p className="text-sm text-muted-foreground">
            <T>
              Run only when every filter matches. Other requests are logged as filtered. Separate
              “is one of” values with commas; a value can't contain a comma.
            </T>
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

type EditorPreset =
  | { readonly threadId: ThreadId; readonly projectId: ProjectId }
  | { readonly profileId: string };

interface EditorTarget {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
  readonly preset?: EditorPreset;
}

export function ScheduledTasksSettings(target: {
  readonly environmentId?: EnvironmentId;
  readonly taskId?: ScheduledTaskId | undefined;
  readonly threadId?: ThreadId | undefined;
}) {
  const navigate = useNavigate({ from: "/settings/scheduled-tasks" });
  return (
    <SettingsPageContainer>
      <ScheduledTaskList
        {...target}
        onLinkClosed={() =>
          void navigate({
            to: "/settings/scheduled-tasks",
            search: ({ taskId: _task, threadId: _thread, ...rest }) => rest,
            replace: true,
          })
        }
      />
    </SettingsPageContainer>
  );
}

/**
 * Every scheduled task in the settings scope, with the editor. Settings and the Agents board
 * both render it. A `taskId`, `threadId` or `profileId` link opens the editor once.
 */
export function ScheduledTaskList(target: {
  readonly environmentId?: EnvironmentId | undefined;
  readonly taskId?: ScheduledTaskId | undefined;
  readonly threadId?: ThreadId | undefined;
  readonly profileId?: string | undefined;
  readonly initialFilter?: ScheduledTaskFilter;
  readonly onLinkClosed: () => void;
}) {
  const setting = useSearchableSetting();
  const gt = useGT();
  const { scope, environments, connectedEnvironments, environment } = useSettingsScope();
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const openForEdit = (environmentId: EnvironmentId, task: ScheduledTask) => {
    setEditor({ environmentId, task });
  };
  const defaultEnvironment = newScheduledTaskEnvironment(
    target.environmentId,
    connectedEnvironments,
    environment,
  );
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
  const linkedThread = useQuietThreadShell(
    target.threadId !== undefined && linkedEnvironmentId !== undefined
      ? scopeThreadRef(linkedEnvironmentId, target.threadId)
      : null,
  );
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
  const { profiles } = useAgentLibrary();
  const providersByEnvironment = useEnvironmentProviders();
  const linkedProfile = profiles.find((profile) => profile.profileId === target.profileId);
  // An agent's task starts on a machine that can run that agent, when one is connected.
  const agentEnvironment = linkedProfile
    ? (permittedEnvironments.find(
        (entry) =>
          agentMachineUnavailableReason(linkedProfile, {
            ...entry,
            providers: providersByEnvironment.get(entry.environmentId),
          }) === undefined,
      ) ?? creationEnvironment)
    : undefined;
  const linkKey =
    target.taskId ??
    (target.threadId !== undefined
      ? `thread:${target.threadId}`
      : target.profileId !== undefined
        ? `agent:${target.profileId}`
        : undefined);
  const linkEditor: EditorTarget | null =
    linkedTask && linkedEnvironmentId !== undefined
      ? { environmentId: linkedEnvironmentId, task: linkedTask }
      : target.threadId !== undefined &&
          linkedThread &&
          permittedEnvironments.some((entry) => entry.environmentId === linkedEnvironmentId)
        ? {
            environmentId: linkedThread.environmentId,
            task: null,
            preset: { threadId: target.threadId, projectId: linkedThread.projectId },
          }
        : linkedProfile && agentEnvironment
          ? {
              environmentId: agentEnvironment.environmentId,
              task: null,
              preset: { profileId: linkedProfile.profileId },
            }
          : null;
  // A link opens its editor once, the first time its target loads. The editor then owns the
  // session until close, so a disconnect that disables the query cannot drop unsaved edits.
  // An editor the user already opened wins: a late-loading link must not replace its draft.
  const [openedLink, setOpenedLink] = useState<string | undefined>();
  if (linkKey === undefined && openedLink !== undefined) {
    setOpenedLink(undefined);
  }
  if (linkEditor && linkKey !== undefined && openedLink !== linkKey) {
    setOpenedLink(linkKey);
    if (editor === null) setEditor(linkEditor);
  }
  const closeEditor = () => {
    setEditor(null);
    if (linkKey !== undefined) target.onLinkClosed();
  };
  const [filter, setFilter] = useState<ScheduledTaskFilter>(target.initialFilter ?? "all");
  const listQueries = useAtomValue(
    scheduledTasksListAtom(
      environmentIdsKey(connectedEnvironments.map((entry) => entry.environmentId)),
    ),
  );
  const archivedCount = listQueries.reduce((count, query, index) => {
    const environmentId = connectedEnvironments[index]!.environmentId;
    const tasks = AsyncResult.getOrElse(query, () => null)?.tasks ?? [];
    return (
      count +
      tasks.filter(
        (task) =>
          isScheduledTaskArchived(task) &&
          matchesScheduledTaskScope(scope, environmentId, task.projectId),
      ).length
    );
  }, 0);
  return (
    <>
      <SettingsSection
        {...setting("scheduled-tasks")}
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
            <T>New task</T>
          </Button>
        }
      >
        <div className="px-3 pb-2 sm:px-4">
          <ToggleGroup
            aria-label="Show tasks"
            className="max-w-full flex-wrap"
            value={[filter]}
            onValueChange={(values) => {
              const next = SCHEDULED_TASK_FILTERS.find((option) => option.value === values[0]);
              if (next) setFilter(next.value);
            }}
          >
            {SCHEDULED_TASK_FILTERS.map((option) => (
              <Toggle key={option.value} value={option.value}>
                {option.label}
                {option.value === "archived" && archivedCount > 0 ? ` (${archivedCount})` : ""}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
        {scope.kind === "unavailable" ? (
          <SettingsSection title={gt("Unavailable selection")}>
            <SettingsRow title={scope.message} />
          </SettingsSection>
        ) : environments.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Clock3Icon />
              </EmptyMedia>
              <EmptyTitle>
                <T>No environments available</T>
              </EmptyTitle>
              <EmptyDescription>
                <T>Connect an environment to manage scheduled tasks.</T>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : environments.length > 1 ? (
          <ScheduledTaskEnvironmentList
            filter={filter}
            profiles={profiles}
            environmentId={linkedEnvironmentId}
            taskId={target.taskId}
            onEdit={openForEdit}
          />
        ) : (
          <div className="space-y-8">
            {environments.map((entry) => (
              <ScheduledTaskEnvironmentSection
                key={entry.environmentId}
                filter={filter}
                profiles={profiles}
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
          preset={editor.preset}
          onClose={closeEditor}
        />
      ) : null}
    </>
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
  filter,
  profiles,
  environmentId,
  taskId,
  onEdit,
}: {
  readonly filter: ScheduledTaskFilter;
  readonly profiles: ReadonlyArray<McpGatewayProfile>;
  readonly environmentId: EnvironmentId | undefined;
  readonly taskId: ScheduledTaskId | undefined;
  readonly onEdit: (environmentId: EnvironmentId, task: ScheduledTask) => void;
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

  const loaded = states
    .filter((state) => state.connected && state.error === null && state.tasks)
    .map((state) => ({
      ...state,
      tasks: (state.tasks ?? []).filter((task) => scheduledTaskMatchesFilter(task, filter)),
    }));
  const populated = loaded.filter((state) => state.tasks.length > 0);
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
      summaries["Loading scheduled tasks on"]!.push(label);
    } else if (
      !tasks.some((task) => scheduledTaskMatchesFilter(task, filter)) &&
      populated.length > 0
    ) {
      summaries["No tasks on"]!.push(label);
    }
  }

  return (
    <SettingsGroup>
      {populated.map(({ environment, tasks, timeZone }) => {
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
                tooltipText={connectionStatusTitle(environment.connection, messages)}
              />
              <span className="text-xs text-muted-foreground">
                {connectionStatusTitle(environment.connection, messages)}
              </span>
            </EnvironmentRow>
            {tasks.map((task) => (
              <ScheduledTaskRow
                key={task.id}
                environmentId={environment.environmentId}
                task={task}
                profiles={profiles}
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
      {populated.length === 0 && loaded.length > 0 ? <EmptyTasksRow filter={filter} /> : null}
      {Object.entries(summaries).map(([label, entries]) => {
        if (entries.length === 0) return null;
        const summary = messages(SCOPE_SUMMARY_TEMPLATES[label] ?? label, {
          environments: entries.join(", "),
        });
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
  filter,
  profiles,
  environment,
  taskId,
  onEdit,
}: {
  readonly filter: ScheduledTaskFilter;
  readonly profiles: ReadonlyArray<McpGatewayProfile>;
  readonly environment: EnvironmentPresentation;
  readonly taskId?: ScheduledTaskId | undefined;
  readonly onEdit: (environmentId: EnvironmentId, task: ScheduledTask) => void;
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
  const shown = tasks?.filter((task) => scheduledTaskMatchesFilter(task, filter));
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
          title={gt("Environment disconnected")}
          description={gt("Reconnect {label} to view its scheduled tasks.", {
            label: environment.label,
          })}
        />
      ) : tasksQuery.error ? (
        <SettingsRow title="Could not load scheduled tasks" description={tasksQuery.error} />
      ) : !tasks || !shown ? (
        <SettingsRow title="Loading scheduled tasks…" role="status" />
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
          {shown.length === 0 ? (
            <EmptyTasksRow filter={filter} />
          ) : (
            shown.map((task) => (
              <ScheduledTaskRow
                key={task.id}
                environmentId={environment.environmentId}
                task={task}
                profiles={profiles}
                timeZone={tasksQuery.data?.timeZone}
                onEdit={() => onEdit(environment.environmentId, task)}
              />
            ))
          )}
        </>
      )}
    </SettingsSection>
  );
}

function EmptyTasksRow({ filter }: { readonly filter: ScheduledTaskFilter }) {
  return filter === "archived" ? (
    <SettingsRow
      title="No archived tasks"
      description="Tasks that stay paused, keep failing, or finish their one-time run are archived here."
    />
  ) : (
    <SettingsRow
      title="No scheduled tasks"
      description={
        filter === "all"
          ? "No tasks match this environment and project selection."
          : "No tasks match this filter and selection."
      }
    />
  );
}

function ScheduledTaskRow({
  environmentId,
  task,
  profiles,
  timeZone,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly profiles: ReadonlyArray<McpGatewayProfile>;
  readonly timeZone: string | undefined;
  readonly onEdit: () => void;
}) {
  const messages = useMessages();
  const gt = useGT();
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const [deliveriesOpen, setDeliveriesOpen] = useState(false);
  const isWebhook = task.schedule.type === "webhook";
  const archived = isScheduledTaskArchived(task);
  const toggle = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "scheduled task enabled",
  });
  const run = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run now",
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "scheduled task delete",
  });
  const act = async (action: "toggle" | "restore" | "run" | "delete") => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    if (action === "restore" && scheduledTaskRestoreNeedsEditor(task, Date.now())) {
      onEdit();
      return;
    }
    if (action === "delete") {
      const message = `${gt('Delete "{title}"?', { title: task.title })}\n${gt("This cannot be undone.")}`;
      const confirmed =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      if (!confirmed) return;
    }
    setBusy(true);
    const result =
      action === "toggle" || action === "restore"
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
        <div className="flex flex-wrap items-center gap-2">
          <span>
            {scheduleLabel(task.schedule, timeZone, task.nextRunAt)} ·{" "}
            {archived ? (
              <>
                {scheduledTaskArchiveLabel(task)}
                {scheduledTaskDeletesLabel(task) ? ` · ${scheduledTaskDeletesLabel(task)}` : null}
              </>
            ) : task.blockedByPolicy !== undefined ? (
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
          {task.profileId !== undefined ? (
            <Badge variant="outline">
              {profiles.find((profile) => profile.profileId === task.profileId)?.name ??
                "Agent unavailable"}
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
          {archived ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !canOperate}
              onClick={() => void act("restore")}
            >
              <ArchiveRestoreIcon />
              Restore
            </Button>
          ) : (
            <Switch
              checked={task.enabled}
              disabled={busy || !canOperate}
              aria-label={`Enable ${task.title}`}
              onCheckedChange={() => void act("toggle")}
            />
          )}
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
              ) : archived ? null : (
                <MenuItem onClick={() => void act("run")}>
                  <PlayIcon />
                  <T>Run now</T>
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem onClick={() => void act("delete")}>
                <Trash2Icon />
                Delete
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
            <T>
              Deliveries · <Var>{task.title}</Var>
            </T>
          </DialogTitle>
          <DialogDescription>
            <T>Recent requests to this task's webhook URL.</T>
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
                <span>
                  {selected.method} · <ScheduledRelativeLabel value={selected.receivedAt} />
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
                      ? "text-sm text-muted-foreground"
                      : "text-sm text-destructive"
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
            <p className="text-sm text-muted-foreground" role="status">
              <T>Loading deliveries…</T>
            </p>
          ) : deliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              <T>No requests yet.</T>
            </p>
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
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter>
          {selectedId !== null ? (
            <Button variant="outline" size="sm" onClick={() => setSelectedId(null)}>
              <T>Back</T>
            </Button>
          ) : (
            <Button
              variant="outline"
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
      <p className="text-sm text-muted-foreground">
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
          variant="outline"
          type="button"
          disabled={!copyable}
          onClick={() => copyToClipboard(url, undefined)}
        >
          <CopyIcon />
          {isCopied ? gt("Copied") : gt("Copy")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={rotating || !canRotate}
          onClick={() => void rotateUrl()}
        >
          <T>Rotate</T>
        </Button>
      </div>
      {note !== null ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      {endpoint.url !== null ? (
        <p className="text-xs text-muted-foreground">
          Reachable only from devices on your tailnet. Services outside it, such as GitHub or
          Linear, cannot call it, and requests fail while this environment is offline.
        </p>
      ) : null}
    </div>
  );
}

function ScheduledTaskEditorDialog({
  initialEnvironmentId,
  task,
  preset,
  onClose,
}: {
  readonly initialEnvironmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
  readonly preset: EditorPreset | undefined;
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
          preset={preset}
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

const AGENT_DESTINATION = "agent";
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
  profiles,
  profileId,
  agentUnavailableReason,
  disabled,
  onSelect,
  onThreadModeChange,
  onAgentChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly threadId: ThreadId | null;
  readonly threadMode: ScheduledTaskThreadMode;
  /** Agents that can run scheduled tasks. */
  readonly profiles: ReadonlyArray<McpGatewayProfile>;
  /** Empty when runs do not go to an agent. */
  readonly profileId: string;
  readonly agentUnavailableReason: string | undefined;
  readonly disabled: boolean;
  readonly onSelect: (thread: { id: ThreadId; projectId: ProjectId } | null) => void;
  /** Absent on servers that predate thread modes. */
  readonly onThreadModeChange: ((mode: ScheduledTaskThreadMode) => void) | undefined;
  readonly onAgentChange: (profileId: string) => void;
}) {
  const gt = useGT();
  const toAgent = profileId !== "";
  const profile = profiles.find((item) => item.profileId === profileId);
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
  const detail = toAgent
    ? threadId === null
      ? "The first run starts a thread for this agent. Later runs post there. The agent's model and permission mode apply."
      : "Each run posts to this agent's thread. The agent's model and permission mode apply."
    : threadMode === "new_thread"
      ? "Each run starts a new thread with the workspace and model below."
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
    <Field label="Destination" htmlFor="scheduled-task-destination">
      {onThreadModeChange || toAgent ? (
        <Select
          value={toAgent ? AGENT_DESTINATION : threadMode}
          onValueChange={(value) => {
            if (value === AGENT_DESTINATION) {
              const first = profiles[0];
              if (!toAgent && first) onAgentChange(first.profileId);
              return;
            }
            onThreadModeChange?.(value as ScheduledTaskThreadMode);
          }}
        >
          <SelectTrigger size="sm" id="scheduled-task-destination">
            <SelectValue>
              {toAgent ? "An agent's thread" : THREAD_MODE_LABELS[threadMode]}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {profiles.length > 0 || toAgent ? (
              <SelectItem value={AGENT_DESTINATION}>An agent's thread</SelectItem>
            ) : null}
            {onThreadModeChange
              ? (Object.keys(THREAD_MODE_LABELS) as ScheduledTaskThreadMode[]).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {THREAD_MODE_LABELS[mode]}
                  </SelectItem>
                ))
              : null}
          </SelectPopup>
        </Select>
      ) : null}
      {toAgent ? (
        <Select value={profileId} onValueChange={(value) => value && onAgentChange(value)}>
          <SelectTrigger size="sm" aria-label="Agent" disabled={disabled}>
            <SelectValue>{profile?.name ?? "Agent unavailable"}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {profiles.map((item) => (
              <SelectItem key={item.profileId} value={item.profileId} label={item.name}>
                {item.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : !onThreadModeChange || threadMode !== "new_thread" ? (
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
            render={<Button variant="outline" size="sm" />}
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
            <ComboboxList className="max-h-72">
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
      <div className="space-y-1 text-sm">
        {toAgent && profile && agentUnavailableReason !== undefined ? (
          <p className="text-destructive" role="status">
            {`${profile.name} can't run here: ${agentUnavailableReason}`}
          </p>
        ) : null}
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

function CronScheduleFields({
  form,
  timezone,
  onFormChange,
  onTimezoneChange,
}: {
  readonly form: RepeatForm;
  readonly timezone: string;
  readonly onFormChange: (form: RepeatForm) => void;
  readonly onTimezoneChange: (timezone: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Repeat" htmlFor="scheduled-task-cron-preset">
        <Select
          value={form.preset}
          onValueChange={(value) => {
            const preset = (Object.keys(REPEAT_PRESETS) as RepeatPreset[]).find(
              (option) => option === value,
            );
            if (!preset) return;
            onFormChange({
              ...form,
              preset,
              expression: preset === "custom" ? repeatFormToCron(form) : form.expression,
            });
          }}
        >
          <SelectTrigger size="sm" id="scheduled-task-cron-preset">
            <SelectValue>{REPEAT_PRESETS[form.preset]}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {(Object.keys(REPEAT_PRESETS) as RepeatPreset[]).map((preset) => (
              <SelectItem key={preset} value={preset}>
                {REPEAT_PRESETS[preset]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>
      {form.preset === "custom" ? (
        <Field
          label="Cron expression"
          hint="minute hour day month weekday"
          htmlFor="scheduled-task-cron-expression"
        >
          <Input
            id="scheduled-task-cron-expression"
            placeholder="0 7 * * 1-5"
            value={form.expression}
            onChange={(event) => onFormChange({ ...form, expression: event.target.value })}
          />
        </Field>
      ) : form.preset === "hourly" ? (
        <Field label="Minute past the hour" htmlFor="scheduled-task-cron-minute">
          <Input
            id="scheduled-task-cron-minute"
            type="number"
            nativeInput
            min={0}
            max={59}
            value={Number(form.time.slice(3))}
            onChange={(event) =>
              onFormChange({
                ...form,
                time: `00:${String(Math.min(59, Math.max(0, event.target.valueAsNumber || 0))).padStart(2, "0")}`,
              })
            }
          />
        </Field>
      ) : (
        <Field label="Time" htmlFor="scheduled-task-cron-time">
          <Input
            id="scheduled-task-cron-time"
            type="time"
            nativeInput
            value={form.time}
            onChange={(event) => onFormChange({ ...form, time: event.target.value })}
          />
        </Field>
      )}
      {form.preset === "weekly" ? (
        <Field label="Day" htmlFor="scheduled-task-cron-day">
          <Select
            value={String(form.weekday)}
            onValueChange={(value) => onFormChange({ ...form, weekday: Number(value) })}
          >
            <SelectTrigger size="sm" id="scheduled-task-cron-day">
              <SelectValue>{WEEKDAY_NAMES[form.weekday]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {WEEKDAY_NAMES.map((name, index) => (
                <SelectItem key={name} value={String(index)}>
                  {name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Field>
      ) : null}
      <Field label="Time zone" htmlFor="scheduled-task-cron-timezone">
        <Input
          id="scheduled-task-cron-timezone"
          placeholder={localTimeZone()}
          value={timezone}
          onChange={(event) => onTimezoneChange(event.target.value)}
        />
      </Field>
    </div>
  );
}

function ScheduledTaskEditorForm({
  initialEnvironmentId,
  task,
  preset,
  saving,
  onSavingChange: setSaving,
  onClose,
}: {
  readonly initialEnvironmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
  readonly preset: EditorPreset | undefined;
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
  const webhookDenial = managedCapabilityDenial(useManagedPolicy(environmentId), "webhookTasks");
  const { profiles } = useAgentLibrary();
  const [draft, setDraft] = useState<DraftState>(() => {
    if (task) return taskToDraft(task);
    const empty = {
      ...EMPTY_DRAFT,
      cronTimezone: localTimeZone(),
      projectId: defaultScheduledTaskProjectId(scopedProjects, scope),
    };
    if (preset === undefined) return empty;
    return "profileId" in preset
      ? moveDraftToAgent(empty, preset.profileId, null)
      : moveDraftToThread(empty, { id: preset.threadId, projectId: preset.projectId });
  });
  const agentProfiles = profiles.filter(
    (profile) => profile.runtimeMode !== "read-only" || profile.profileId === draft.profileId,
  );
  const draftProfile = profiles.find((profile) => profile.profileId === draft.profileId);
  const agentUnavailableReason =
    draftProfile && environment
      ? agentMachineUnavailableReason(draftProfile, { ...environment, providers })
      : undefined;
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
      (draft.profileId === "" && selection === null)
    ) {
      reportFailure(
        "Scheduled task is incomplete",
        draft.profileId === ""
          ? "Add a title, prompt, project, and model."
          : "Add a title, prompt, and project.",
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
        "Once is not available here",
        `This environment runs an older ${APP_NAME}. Update it to schedule a one-time task, or pick another schedule.`,
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
    const routing = scheduledTaskDraftRouting(draft, task, {
      profiles,
      providers,
      offersThreadModes,
      modelSelection:
        selection !== null &&
        draft.baseModelSelection !== null &&
        draft.baseModelSelection.instanceId === selection.instanceId &&
        draft.baseModelSelection.model === selection.model
          ? draft.baseModelSelection
          : selection,
    });
    if (typeof routing === "string") {
      reportFailure("Could not save scheduled task", routing);
      return;
    }
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
      workspaceStrategy,
      ...routing,
      // Tasks have no mode picker; a mode above the administrator's ceiling would fail every run.
      runtimeMode:
        clampManagedRuntimeMode(environment?.serverConfig?.managedPolicy, routing.runtimeMode) ??
        routing.runtimeMode,
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
        <DialogTitle>{draft.editingId ? gt("Edit task") : gt("New task")}</DialogTitle>
        <DialogDescription>
          <T>
            Run a prompt automatically on an interval, at a fixed time, once at a set date, or when
            a webhook is called.
          </T>
        </DialogDescription>
      </DialogHeader>

      <DialogPanel>
        {/* Fieldsets default to min-width: min-content, which lets one wide control widen the form past the dialog. */}
        <fieldset disabled={saving} className="min-w-0 space-y-5">
          {!connected ? (
            <p className="text-sm text-destructive">
              <T>Reconnect this environment before saving.</T>
            </p>
          ) : null}
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
            profiles={agentProfiles}
            profileId={draft.profileId}
            agentUnavailableReason={agentUnavailableReason}
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
                    setDraft((current) => {
                      const offAgent = moveDraftOffAgent(current);
                      return {
                        ...(threadMode === "new_thread"
                          ? unbindDraftFromThread(offAgent)
                          : offAgent),
                        threadMode,
                      };
                    })
                : undefined
            }
            onAgentChange={(profileId) =>
              setDraft((current) => moveDraftToAgent(current, profileId, task))
            }
          />

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
                        <span className="block max-w-72 truncate text-xs text-muted-foreground">
                          {project.workspaceRoot}
                        </span>
                      ) : null}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>

            <Field label={gt("Workspace")} htmlFor="scheduled-task-workspace">
              <Select
                value={draft.workspaceMode}
                onValueChange={(value) =>
                  setDraft((current) => ({ ...current, workspaceMode: value as WorkspaceMode }))
                }
              >
                <SelectTrigger size="sm" id="scheduled-task-workspace">
                  <SelectValue>{messages(WORKSPACE_MODE_LABELS[draft.workspaceMode])}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="worktree">
                    <T>Create a new worktree</T>
                  </SelectItem>
                  <SelectItem value="root">
                    <T>Use the project checkout</T>
                  </SelectItem>
                  <SelectItem value="existing_worktree">
                    <T>Use a specific checkout</T>
                  </SelectItem>
                </SelectPopup>
              </Select>
            </Field>
          </div>

          {draft.workspaceMode === "worktree" ? (
            <Field label={gt("Base branch")} htmlFor="scheduled-task-base-ref">
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
            <Field label={gt("Checkout path")} htmlFor="scheduled-task-checkout">
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

          <Field label={gt("Prompt")} htmlFor="scheduled-task-prompt">
            <Textarea
              id="scheduled-task-prompt"
              className="max-h-64 overflow-y-auto"
              placeholder={gt("What should the agent do each time this runs?")}
              value={draft.prompt}
              onChange={(event) =>
                setDraft((current) => ({ ...current, prompt: event.target.value }))
              }
            />
          </Field>

          {draft.profileId !== "" ? null : (
            <Field label="Model">
              <div>
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
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onInstanceModelChange={(instanceId, model) =>
                    setDraft((current) => ({ ...current, modelKey: `${instanceId}:${model}` }))
                  }
                />
              </div>
            </Field>
          )}

          <div className="space-y-3">
            {task?.schedule.type === "interval" &&
            task.schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS ? (
              <p className="text-sm text-muted-foreground" role="status">
                <T>
                  This task uses a legacy interval below one minute. Saving updates it to at least
                  one minute.
                </T>
              </p>
            ) : null}
            {/* Wraps the toggle below the label when both don't fit, as on phones. */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>
                <T>Schedule</T>
              </Label>
              <ToggleGroup
                aria-label="Schedule type"
                className="max-w-full flex-wrap"
                value={[draft.scheduleMode]}
                onValueChange={(values) => {
                  const mode = values[0] as ScheduleMode | undefined;
                  if (
                    mode === "fixed" ||
                    mode === "once" ||
                    mode === "interval" ||
                    mode === "cron" ||
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
                <Toggle value="interval">Every interval</Toggle>
                <Toggle value="cron">Cron</Toggle>
                <Toggle
                  value="webhook"
                  disabled={webhookDenial !== undefined && draft.scheduleMode !== "webhook"}
                >
                  <T>On webhook</T>
                </Toggle>
              </ToggleGroup>
            </div>

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
            {draft.scheduleMode === "cron" ? (
              <CronScheduleFields
                form={draft.cron}
                timezone={draft.cronTimezone}
                onFormChange={(cron) => setDraft((current) => ({ ...current, cron }))}
                onTimezoneChange={(cronTimezone) =>
                  setDraft((current) => ({ ...current, cronTimezone }))
                }
              />
            ) : draft.scheduleMode === "webhook" &&
              webhookDenial !== undefined &&
              draft.enabled ? null : draft.scheduleMode === "webhook" ? (
              <div className="space-y-4">
                <WebhookEndpointField environmentId={environmentId} task={liveTask} />
                <p className="text-xs text-muted-foreground">
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
                <p className="text-xs text-muted-foreground">
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
                <p className="text-xs text-muted-foreground">
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
                    <p className="text-sm text-muted-foreground">
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
              <div className="flex items-center gap-2">
                <Label htmlFor="scheduled-task-run-at">
                  <T>Run on</T>
                </Label>
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
                  <Label htmlFor="scheduled-task-time">
                    <T>Run at</T>
                  </Label>
                  <Input
                    type="time"
                    id="scheduled-task-time"
                    aria-describedby={
                      runAtZone === undefined ? undefined : "scheduled-task-time-zone"
                    }
                    nativeInput
                    className="w-32"
                    value={draft.timeOfDay}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, timeOfDay: event.target.value }))
                    }
                  />
                  {runAtZone === undefined ? null : (
                    <span id="scheduled-task-time-zone" className="text-xs text-muted-foreground">
                      {runAtZone}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    <T context="between the run time and the weekday buttons, as in Run at 9:00 on Mon Wed">
                      on
                    </T>
                  </span>
                </div>
                <ToggleGroup
                  multiple
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
                      {messages(WEEKDAY_SHORT[day])}
                    </Toggle>
                  ))}
                </ToggleGroup>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Label htmlFor="scheduled-task-interval">
                  <T>Run every</T>
                </Label>
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
                <span className="text-xs text-muted-foreground">minutes</span>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <Label htmlFor="scheduled-task-enabled">
                <T>Enabled</T>
              </Label>
              <p id="scheduled-task-enabled-description" className="text-sm text-muted-foreground">
                <T>Disabled tasks stay saved but do not run.</T>
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
          <T>Cancel</T>
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
          {draft.editingId ? gt("Save task") : gt("Create task")}
        </Button>
      </DialogFooter>
    </>
  );
}
