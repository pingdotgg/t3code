import { useAtomValue } from "@effect/atom-react";
import {
  Clock3Icon,
  CopyIcon,
  InboxIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertInput,
  ScheduledTaskWebhookDeliveryOutcome,
  ScheduledTaskWebhookDeliverySummary,
  ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_WEBHOOK_PROMPT } from "@t3tools/client-runtime/scheduled-task-webhook";
import {
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ProviderInstanceId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { formatRelativeTime } from "../../timestampFormat";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { usePrimaryCloudLinkState } from "../../cloud/primaryCloudLinkState";
import { requestConfirmDialog } from "../../confirmDialog";
import { webhookAddress } from "@t3tools/client-runtime/webhook-address";
import { Link } from "@tanstack/react-router";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  useEnvironment,
  useEnvironmentHttpBaseUrl,
  type EnvironmentPresentation,
} from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorktreeBaseBranchPicker } from "../WorktreeBaseBranchPicker";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useEnvironmentScope, readEnvironmentScope } from "~/state/session";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  WEBHOOK_SIGNATURE_DEFAULTS,
  matchesScheduledTaskScope,
  scheduleFromDraft,
  scheduledTaskDefaultModel,
  taskToDraft,
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
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  useRelativeTimeTick,
} from "./settingsLayout";

/** JS day-of-week (0 = Sunday) rendered Monday-first, matching how people read a week. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

const WORKSPACE_MODE_LABELS: Record<WorkspaceMode, string> = {
  worktree: "Create a new worktree",
  root: "Use the project checkout",
  existing_worktree: "Use a specific checkout",
};

const EMPTY_DRAFT: DraftState = {
  editingId: null,
  title: "",
  prompt: "",
  enabled: true,
  scheduleMode: "fixed",
  intervalMinutes: "15",
  timeOfDay: "09:00",
  weekdays: new Set([1, 2, 3, 4, 5]),
  projectId: "",
  threadId: "",
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
};

/** Labelled field: a caption sitting above its control. */
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

export function scheduleLabel(schedule: ScheduledTaskSchedule): string {
  if (schedule.type === "webhook") return "On webhook";
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    return Number.isInteger(minutes)
      ? `Every ${minutes} min`
      : `Every ${Math.round(schedule.everyMs / 1000)} sec`;
  }
  const weekdays = schedule.weekdays ?? [];
  const days =
    weekdays.length === 0
      ? "Daily"
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? "Weekdays"
        : weekdays.map((day) => WEEKDAY_LABELS[day]).join(", ");
  return `${days} at ${schedule.timeOfDay}`;
}

/**
 * Human label for a run timestamp. `formatRelativeTime` only handles the
 * past, and `nextRunAt` is a future instant — render "in 5m" style labels
 * for upcoming runs instead of a misleading "just now".
 */
export function relativeLabel(value: string | null): string {
  if (!value) return "Not scheduled";
  const diffMs = new Date(value).getTime() - Date.now();
  if (diffMs <= 0) {
    const relative = formatRelativeTime(value);
    if (!relative) return "Not scheduled";
    return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
  }
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 2) return "in under a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

const DELIVERY_OUTCOME_LABELS: Record<ScheduledTaskWebhookDeliveryOutcome, string> = {
  accepted: "Ran",
  dispatch_failed: "Run failed",
  rejected_signature: "Bad signature",
  disabled: "Task paused",
  rate_limited: "Rate limited",
  expired: "Too old",
};

function deliveryOutcomeVariant(outcome: ScheduledTaskWebhookDeliveryOutcome) {
  if (outcome === "accepted") return "success";
  if (outcome === "disabled" || outcome === "rate_limited" || outcome === "expired") {
    return "warning";
  }
  return "error";
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
  const { scope, environments, connectedEnvironments, environment } = useSettingsScope();
  const [editor, setEditor] = useState<{
    environmentId: EnvironmentId;
    task: ScheduledTask | null;
  } | null>(null);
  const openForEdit = useCallback((environmentId: EnvironmentId, task: ScheduledTask) => {
    setEditor({ environmentId, task });
  }, []);
  const defaultEnvironment = environment ?? connectedEnvironments[0];
  const canCreate = useEnvironmentScope(
    defaultEnvironment?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Scheduled tasks"
        variant="plain"
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!defaultEnvironment || !canCreate}
            onClick={() =>
              defaultEnvironment &&
              setEditor({ environmentId: defaultEnvironment.environmentId, task: null })
            }
          >
            <PlusIcon className="size-3" />
            New task
          </Button>
        }
      >
        {scope.kind === "unavailable" ? (
          <SettingsSection title="Unavailable selection">
            <SettingsRow title={scope.message} />
          </SettingsSection>
        ) : environments.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Clock3Icon />
              </EmptyMedia>
              <EmptyTitle>No environments available</EmptyTitle>
              <EmptyDescription>Connect an environment to manage scheduled tasks.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="space-y-8">
            {environments.map((entry) => (
              <ScheduledTaskEnvironmentSection
                key={`${entry.environmentId}:${target.taskId ?? ""}`}
                environment={entry}
                showEnvironmentHeading={environments.length > 1}
                taskId={
                  (target.environmentId ?? defaultEnvironment?.environmentId) ===
                  entry.environmentId
                    ? target.taskId
                    : undefined
                }
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
          onClose={() => setEditor(null)}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function ScheduledTaskEnvironmentSection({
  environment,
  showEnvironmentHeading,
  taskId,
  onEdit,
}: {
  readonly environment: EnvironmentPresentation;
  readonly showEnvironmentHeading: boolean;
  readonly taskId?: ScheduledTaskId | undefined;
  readonly onEdit: (environmentId: EnvironmentId, task: ScheduledTask) => void;
}) {
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
  const openedLink = useRef(false);
  useEffect(() => {
    if (!openedLink.current && linkedTask) {
      openedLink.current = true;
      onEdit(environment.environmentId, linkedTask);
    }
  }, [environment.environmentId, linkedTask, onEdit]);
  useRelativeTimeTick(60_000);
  return (
    <SettingsSection
      title={environment.label}
      hideTitle={!showEnvironmentHeading}
      icon={
        <EnvironmentMachineIcon
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          className="size-3.5"
        />
      }
    >
      {!connected ? (
        <SettingsRow
          title="Environment disconnected"
          description={`Reconnect ${environment.label} to view its scheduled tasks.`}
        />
      ) : tasksQuery.error ? (
        <SettingsRow title="Could not load scheduled tasks" description={tasksQuery.error} />
      ) : !tasks ? (
        <SettingsRow title="Loading scheduled tasks…" role="status" />
      ) : (
        <>
          {taskId && !linkedTask ? (
            <SettingsRow
              title="Task unavailable"
              description="This task no longer exists or is outside the selected project scope."
              role="status"
            />
          ) : null}
          {tasks.length === 0 ? (
            <SettingsRow
              title="No scheduled tasks"
              description="No tasks match this environment and project selection."
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
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
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
          title: "Could not update scheduled task",
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
            {!task.enabled
              ? "Paused"
              : isWebhook
                ? "Listening"
                : task.nextRunAt
                  ? `Next run ${relativeLabel(task.nextRunAt)}`
                  : "Not scheduled"}
          </span>
          {task.lastRunStatus !== "never" ? (
            <Badge variant={statusVariant(task.lastRunStatus)}>{task.lastRunStatus}</Badge>
          ) : null}
          {task.lastRunError ? <span className="text-destructive">{task.lastRunError}</span> : null}
        </div>
      }
      control={
        <div className="flex items-center gap-2">
          <Switch
            checked={task.enabled}
            disabled={busy || !canOperate}
            aria-label={`Enable ${task.title}`}
            onCheckedChange={() => void act("toggle")}
          />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy || !canOperate}
                  aria-label={`Actions for ${task.title}`}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={onEdit}>
                <PencilIcon />
                Edit
              </MenuItem>
              {isWebhook ? (
                <MenuItem onClick={() => setDeliveriesOpen(true)}>
                  <InboxIcon />
                  Deliveries
                </MenuItem>
              ) : (
                <MenuItem onClick={() => void act("run")}>
                  <PlayIcon />
                  Run now
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

function WebhookDeliveriesDialog({
  environmentId,
  task,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly onClose: () => void;
}) {
  const deliveriesQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTaskWebhookDeliveries({ environmentId, input: { id: task.id } }),
  );
  const [selectedId, setSelectedId] = useState<ScheduledTaskWebhookDeliverySummary["id"] | null>(
    null,
  );
  const selectedQuery = useEnvironmentQuery(
    selectedId === null
      ? null
      : serverEnvironment.scheduledTaskWebhookDelivery({
          environmentId,
          input: { id: task.id, deliveryId: selectedId },
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
          <DialogTitle>Deliveries · {task.title}</DialogTitle>
          <DialogDescription>Recent requests to this task's webhook URL.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {selectedId !== null && selected === null && selectedQuery.error === null ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading delivery…
            </p>
          ) : selected ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant={deliveryOutcomeVariant(selected.outcome)}>
                  {DELIVERY_OUTCOME_LABELS[selected.outcome]}
                </Badge>
                <span>
                  {selected.method} · {relativeLabel(selected.receivedAt)}
                </span>
                {selected.signatureVerified ? (
                  <span className="text-muted-foreground">Signature verified</span>
                ) : null}
              </div>
              {selected.error ? <p className="text-sm text-destructive">{selected.error}</p> : null}
              <DeliveryBlock title="Prompt sent to the agent">
                {selected.renderedPrompt ?? "No run was started for this request."}
              </DeliveryBlock>
              {selected.missingFields.length > 0 ? (
                <p className="text-sm text-muted-foreground">
                  Empty placeholders: {selected.missingFields.join(", ")}
                </p>
              ) : null}
              <DeliveryBlock title="Headers">
                {Object.entries(selected.headers)
                  .map(([name, value]) => `${name}: ${value}`)
                  .join("\n")}
              </DeliveryBlock>
              {selected.query ? (
                <DeliveryBlock title="Query">{selected.query}</DeliveryBlock>
              ) : null}
              <DeliveryBlock title={selected.bodyTruncated ? "Body (truncated)" : "Body"}>
                {selected.body || "(empty)"}
              </DeliveryBlock>
            </div>
          ) : selectedId !== null ? null : deliveries === null ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading deliveries…
            </p>
          ) : deliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No requests yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {deliveries.map((delivery) => (
                <li key={delivery.id}>
                  <button
                    type="button"
                    className="flex w-full flex-wrap items-center gap-2 py-2 text-left text-sm hover:bg-accent/40"
                    onClick={() => setSelectedId(delivery.id)}
                  >
                    <Badge variant={deliveryOutcomeVariant(delivery.outcome)}>
                      {DELIVERY_OUTCOME_LABELS[delivery.outcome]}
                    </Badge>
                    <span>{delivery.method}</span>
                    <span className="text-muted-foreground">
                      {relativeLabel(delivery.receivedAt)}
                    </span>
                    {delivery.missingFields.length > 0 ? (
                      <span className="text-muted-foreground">
                        {delivery.missingFields.length} empty placeholder
                        {delivery.missingFields.length === 1 ? "" : "s"}
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
              Back
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={deliveriesQuery.isPending}
              onClick={deliveriesQuery.refresh}
            >
              Refresh
            </Button>
          )}
          <DialogClose render={<Button size="sm" />}>Done</DialogClose>
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
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "webhook URL" });
  const rotate = useAtomCommand(serverEnvironment.rotateScheduledTaskWebhookToken, {
    label: "scheduled task rotate webhook token",
  });
  const [rotating, setRotating] = useState(false);
  const endpoint = task?.webhook;
  if (!task || !endpoint) {
    return <p className="text-sm text-muted-foreground">The URL appears after you save.</p>;
  }
  const { address: url, copyable, note } = webhookAddress(endpoint, httpBaseUrl);
  const rotateUrl = async () => {
    const confirmed =
      (await requestConfirmDialog("Rotate this webhook URL?\nThe current URL stops working.", {
        variant: "destructive",
      })) ??
      // No themed dialog host is mounted; fall back to the native prompt
      // rather than rotating unasked.
      window.confirm("Rotate this webhook URL? The current URL stops working.");
    if (!confirmed) return;
    setRotating(true);
    const result = await rotate({ environmentId, input: { id: task.id } });
    setRotating(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not rotate webhook URL",
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
          aria-label="Webhook URL"
          value={url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button
          size="sm"
          variant="outline"
          type="button"
          // A bare path is not a URL a sender can call.
          disabled={!copyable}
          onClick={() => copyToClipboard(url, undefined)}
        >
          <CopyIcon />
          {isCopied ? "Copied" : "Copy"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={rotating}
          onClick={() => void rotateUrl()}
        >
          Rotate
        </Button>
      </div>
      {note !== null ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      {endpoint.url !== null ? <WebhookDeliveryMode environmentId={environmentId} /> : null}
    </div>
  );
}

/**
 * Whether T3 Connect forwards requests live or holds them while the
 * environment is offline. The setting is per environment and only readable
 * for this machine's own environment, so other environments show nothing.
 */
function WebhookDeliveryMode({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const cloudLink = usePrimaryCloudLinkState();
  if (cloudLink.target?.environmentId !== environmentId || cloudLink.data === null) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {cloudLink.data.holdWebhooksWhileOffline
        ? "Held for up to 24 hours while this environment is offline. "
        : "Forwarded live. Requests fail while this environment is offline. "}
      <Link to="/settings/connections" className="underline underline-offset-2">
        Change in Connections
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
  const { scope, connectedEnvironments } = useSettingsScope();
  const [environmentId, setEnvironmentId] = useState(initialEnvironmentId);
  const environment = useEnvironment(environmentId);
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  const tasksQuery = useEnvironmentQuery(
    connected ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} }) : null,
  );
  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      allProjects.filter(
        (project) =>
          project.environmentId === environmentId &&
          matchesScheduledTaskScope(scope, environmentId, project.id),
      ),
    [allProjects, environmentId, scope],
  );
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const upsertTask = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "scheduled task upsert",
  });
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const [draft, setDraft] = useState<DraftState>(() =>
    task ? taskToDraft(task) : { ...EMPTY_DRAFT, projectId: projects[0]?.id ?? "" },
  );
  const [saving, setSaving] = useState(false);
  const submissionPending = useRef(false);
  const editingTaskMissing =
    draft.editingId !== null &&
    tasksQuery.data !== null &&
    !tasksQuery.data.tasks.some((entry) => entry.id === draft.editingId);
  // The live row, so a rotated URL shows up without reopening the dialog.
  // Once the list has loaded, a missing task is gone; don't keep showing its URL.
  const liveTask = tasksQuery.data
    ? (tasksQuery.data.tasks.find((entry) => entry.id === draft.editingId) ?? null)
    : task;
  const selectedProjectId = draft.projectId || projects[0]?.id || "";
  const selectedProject = projects.find((project) => project.id === selectedProjectId);

  // The real model picker is keyed by a `${instanceId}:${model}` string, which
  // is exactly how the draft stores its selection.
  const firstInstance = instanceEntries[0];
  const activeSelection = draft.modelKey
    ? splitModelKey(draft.modelKey)
    : scheduledTaskDefaultModel(settings, selectedProject ?? null, instanceEntries);
  const activeInstanceId =
    activeSelection?.instanceId ?? firstInstance?.instanceId ?? ("" as ProviderInstanceId);
  const activeModel = activeSelection?.model ?? "";
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers, activeInstanceId, activeModel),
    [settings, providers, activeInstanceId, activeModel],
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
      reportFailure("Scheduled task is incomplete", "Add a title, prompt, project, and model.");
      return;
    }
    const schedule = scheduleFromDraft(draft);
    if (schedule === null) {
      reportFailure(
        "Invalid age limit",
        `Enter whole minutes from 1 to ${MAX_WEBHOOK_DELIVERY_AGE_MINUTES}, or leave it blank.`,
      );
      return;
    }
    if (
      schedule.type === "webhook" &&
      schedule.signature &&
      (!schedule.signature.header ||
        (!schedule.signature.secret &&
          !(liveTask?.schedule.type === "webhook" && liveTask.webhook?.hasSecret)))
    ) {
      reportFailure("Signing secret is required", "Enter the signature header and secret.");
      return;
    }
    if (
      schedule.type === "interval" &&
      (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS)
    ) {
      reportFailure("Invalid interval", "Enter an interval of at least one minute.");
      return;
    }
    if (draft.workspaceMode === "existing_worktree" && !draft.existingWorktreePath.trim()) {
      reportFailure("Checkout path is required", "Enter the path of the checkout to run in.");
      return;
    }
    // Keep the original selection object (with provider options) when the
    // picker still points at the same instance+model.
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
      workspaceStrategy,
      modelSelection,
      runtimeMode: draft.runtimeMode,
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
        reportFailure("Could not save scheduled task", squashAtomCommandFailure(result));
      }
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{draft.editingId ? "Edit task" : "New task"}</DialogTitle>
          <DialogDescription>
            Run a prompt automatically — on an interval, at a fixed time, or when a webhook is
            called.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <fieldset disabled={saving} className="space-y-5">
            {!connected ? (
              <p className="text-sm text-destructive">Reconnect this environment before saving.</p>
            ) : null}
            <Field label="Runs on" htmlFor="scheduled-task-environment">
              <Select
                value={environmentId}
                disabled={task !== null || saving}
                onValueChange={(id) => {
                  const next = connectedEnvironments.find((entry) => entry.environmentId === id);
                  if (!next) return;
                  setEnvironmentId(next.environmentId);
                  setDraft((current) => ({
                    ...current,
                    projectId: "",
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
                      {environment?.label ?? "Unavailable environment"}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {connectedEnvironments.map((entry) => (
                    <SelectItem key={entry.environmentId} value={entry.environmentId}>
                      <EnvironmentMachineIcon
                        kind={resolveEnvironmentMachineKind(entry.serverConfig)}
                        className="size-4"
                      />
                      {entry.label}
                    </SelectItem>
                  ))}
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
                This scheduled task no longer exists.
              </p>
            ) : null}
            <Field label="Name" htmlFor="scheduled-task-title">
              <Input
                id="scheduled-task-title"
                placeholder="e.g. Check for Sentry issues"
                value={draft.title}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, title: event.target.value }))
                }
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Project" htmlFor="scheduled-task-project">
                <Select
                  value={selectedProjectId}
                  onValueChange={(projectId) =>
                    setDraft((current) => ({ ...current, projectId: projectId ?? "" }))
                  }
                >
                  <SelectTrigger size="sm" id="scheduled-task-project">
                    <SelectValue placeholder="Select a project">
                      {selectedProject?.title}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>

              <Field label="Workspace" htmlFor="scheduled-task-workspace">
                <Select
                  value={draft.workspaceMode}
                  onValueChange={(value) =>
                    setDraft((current) => ({ ...current, workspaceMode: value as WorkspaceMode }))
                  }
                >
                  <SelectTrigger size="sm" id="scheduled-task-workspace">
                    <SelectValue>{WORKSPACE_MODE_LABELS[draft.workspaceMode]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="worktree">Create a new worktree</SelectItem>
                    <SelectItem value="root">Use the project checkout</SelectItem>
                    <SelectItem value="existing_worktree">Use a specific checkout</SelectItem>
                  </SelectPopup>
                </Select>
              </Field>
            </div>

            {draft.workspaceMode === "worktree" ? (
              <Field label="Base branch" htmlFor="scheduled-task-base-ref">
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
              <Field label="Checkout path" htmlFor="scheduled-task-checkout">
                <Input
                  id="scheduled-task-checkout"
                  value={draft.existingWorktreePath}
                  placeholder="/path/to/checkout"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      existingWorktreePath: event.target.value,
                    }))
                  }
                />
              </Field>
            ) : null}

            <Field label="Prompt" htmlFor="scheduled-task-prompt">
              <Textarea
                id="scheduled-task-prompt"
                className="max-h-64 overflow-y-auto"
                placeholder="What should the agent do each time this runs?"
                value={draft.prompt}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, prompt: event.target.value }))
                }
              />
            </Field>

            <Field label="Model">
              <ProviderModelPicker
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
            </Field>

            <div className="space-y-3">
              {task?.schedule.type === "interval" &&
              task.schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS ? (
                <p className="text-sm text-muted-foreground" role="status">
                  This task uses a legacy interval below one minute. Saving updates it to at least
                  one minute.
                </p>
              ) : null}
              <div className="flex items-center justify-between gap-2">
                <Label>Schedule</Label>
                <ToggleGroup
                  aria-label="Schedule type"
                  value={[draft.scheduleMode]}
                  onValueChange={(values) => {
                    const mode = values[0] as ScheduleMode | undefined;
                    if (mode === "fixed" || mode === "interval" || mode === "webhook")
                      setDraft((current) => ({
                        ...current,
                        scheduleMode: mode,
                        prompt:
                          mode === "webhook" && !current.prompt.trim()
                            ? DEFAULT_WEBHOOK_PROMPT
                            : current.prompt,
                      }));
                  }}
                >
                  <Toggle value="fixed">At a time</Toggle>
                  <Toggle value="interval">Every interval</Toggle>
                  <Toggle value="webhook">On webhook</Toggle>
                </ToggleGroup>
              </div>

              {draft.scheduleMode === "webhook" ? (
                <div className="space-y-4">
                  <WebhookEndpointField environmentId={environmentId} task={liveTask} />
                  <p className="text-xs text-muted-foreground">
                    {
                      "Each request runs the prompt. Use {{body.path}}, {{headers.name}}, {{query.name}}, {{body}} or {{request}} in the prompt; only what it names reaches the agent."
                    }
                  </p>
                  <Field
                    label="Skip requests older than"
                    hint="minutes, optional"
                    htmlFor="scheduled-task-max-age"
                  >
                    <Input
                      id="scheduled-task-max-age"
                      type="number"
                      nativeInput
                      min={1}
                      max={MAX_WEBHOOK_DELIVERY_AGE_MINUTES}
                      placeholder="Run every request"
                      value={draft.maxDeliveryAgeMinutes}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          maxDeliveryAgeMinutes: event.target.value,
                        }))
                      }
                    />
                  </Field>
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor="scheduled-task-signature">Require signature</Label>
                      <p className="text-sm text-muted-foreground">
                        Reject requests without a valid HMAC-SHA256 signature of the body.
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
                      <Field label="Header" htmlFor="scheduled-task-signature-header">
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
                      <Field label="Prefix" htmlFor="scheduled-task-signature-prefix">
                        <Input
                          id="scheduled-task-signature-prefix"
                          value={draft.signaturePrefix}
                          placeholder="None"
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              signaturePrefix: event.target.value,
                            }))
                          }
                        />
                      </Field>
                      <Field label="Encoding" htmlFor="scheduled-task-signature-encoding">
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
                      <Field label="Secret" htmlFor="scheduled-task-signature-secret">
                        <Input
                          id="scheduled-task-signature-secret"
                          type="password"
                          autoComplete="off"
                          value={draft.signatureSecret}
                          placeholder={
                            liveTask?.schedule.type === "webhook" && liveTask.webhook?.hasSecret
                              ? "Unchanged"
                              : "Shared secret"
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
              ) : draft.scheduleMode === "fixed" ? (
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="scheduled-task-time">Run at</Label>
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
                    <span className="text-xs text-muted-foreground">on</span>
                  </div>
                  <ToggleGroup
                    multiple
                    variant="outline"
                    size="sm"
                    aria-label="Days to run"
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
                      <Toggle key={day} value={String(day)} aria-label={WEEKDAY_LABELS[day]}>
                        {WEEKDAY_SHORT[day]}
                      </Toggle>
                    ))}
                  </ToggleGroup>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Label htmlFor="scheduled-task-interval">Run every</Label>
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
                <Label htmlFor="scheduled-task-enabled">Enabled</Label>
                <p
                  id="scheduled-task-enabled-description"
                  className="text-sm text-muted-foreground"
                >
                  Disabled tasks stay saved but do not run.
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
            Cancel
          </DialogClose>
          <Button
            size="sm"
            disabled={!canOperate || saving || editingTaskMissing || !connected || !tasksQuery.data}
            onClick={() => void submit()}
          >
            {draft.editingId ? "Save task" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
