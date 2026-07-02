import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { CalendarClockIcon, Edit2Icon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
  type ProviderInteractionMode,
  type ProviderDriverKind,
  type RuntimeMode,
  type ScheduledTaskCadence,
  type ScheduledTaskCreateInput,
  type ScheduledTaskSnapshot,
  type ScheduledTaskTarget,
  type ScheduledTaskWorkspace,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  primaryServerProvidersAtom,
  primaryServerScheduledTasksAtom,
  primaryServerSettingsAtom,
  serverEnvironment,
} from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
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
import { SettingsPageContainer, SettingsSection, useRelativeTimeTick } from "./settingsLayout";

const CADENCE_LABELS: Record<ScheduledTaskCadence, string> = {
  hourly: "Hourly",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Approval required",
  "auto-accept-edits": "Auto-accept edits",
  "full-access": "Full access",
};

const INTERACTION_MODE_LABELS: Record<ProviderInteractionMode, string> = {
  default: "Default",
  plan: "Plan",
};

const RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
];
const INTERACTION_MODES: ReadonlyArray<ProviderInteractionMode> = ["default", "plan"];
const CADENCES: ReadonlyArray<ScheduledTaskCadence> = ["hourly", "daily", "weekly", "monthly"];
const TARGET_TYPE_LABELS: Record<ScheduledTaskTarget["type"], string> = {
  standalone: "Standalone chat",
  project: "Project chat",
};
const NO_PROJECT_VALUE = "__no_project__";
const NO_PROVIDER_VALUE = "__no_provider__";

interface ProviderOption {
  readonly instanceId: string;
  readonly driver: ProviderDriverKind;
  readonly displayName?: string | undefined;
  readonly badgeLabel?: string | undefined;
  readonly models: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
}

interface FormState {
  readonly title: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly cadence: ScheduledTaskCadence;
  readonly targetType: ScheduledTaskTarget["type"];
  readonly projectId: string;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceMode: ScheduledTaskWorkspace["mode"];
  readonly localWorktreePath: string;
  readonly baseBranch: string;
  readonly startFromOrigin: boolean;
}

function providerLabel(provider: ProviderOption) {
  return provider.displayName ?? provider.badgeLabel ?? provider.instanceId;
}

function defaultModelForProvider(provider: ProviderOption | null): string {
  return (
    provider?.models[0]?.slug ??
    (provider ? DEFAULT_MODEL_BY_PROVIDER[provider.driver] : null) ??
    DEFAULT_MODEL
  );
}

function formFromTask(
  task: ScheduledTaskSnapshot | null,
  defaults: {
    readonly targetType: ScheduledTaskTarget["type"];
    readonly projectId: string;
    readonly providerInstanceId: string;
    readonly model: string;
    readonly workspaceMode: ScheduledTaskWorkspace["mode"];
    readonly startFromOrigin: boolean;
  },
): FormState {
  if (task) {
    return {
      title: task.title,
      prompt: task.prompt,
      enabled: task.enabled,
      cadence: task.cadence,
      targetType: task.target.type,
      projectId: task.target.type === "project" ? task.target.projectId : defaults.projectId,
      providerInstanceId: task.modelSelection.instanceId,
      model: task.modelSelection.model,
      runtimeMode: task.runtimeMode,
      interactionMode: task.interactionMode,
      workspaceMode: task.target.type === "project" ? task.target.workspace.mode : "local",
      localWorktreePath:
        task.target.type === "project" && task.target.workspace.mode === "local"
          ? (task.target.workspace.worktreePath ?? "")
          : "",
      baseBranch:
        task.target.type === "project" && task.target.workspace.mode === "worktree"
          ? task.target.workspace.baseBranch
          : "main",
      startFromOrigin:
        task.target.type === "project" && task.target.workspace.mode === "worktree"
          ? task.target.workspace.startFromOrigin
          : defaults.startFromOrigin,
    };
  }

  return {
    title: "",
    prompt: "",
    enabled: true,
    cadence: "daily",
    targetType: defaults.targetType,
    projectId: defaults.projectId,
    providerInstanceId: defaults.providerInstanceId,
    model: defaults.model,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    workspaceMode: defaults.workspaceMode,
    localWorktreePath: "",
    baseBranch: "main",
    startFromOrigin: defaults.startFromOrigin,
  };
}

function toScheduledTaskInput(form: FormState): ScheduledTaskCreateInput | null {
  const title = form.title.trim();
  const prompt = form.prompt.trim();
  const projectId = form.projectId.trim();
  const providerInstanceId = form.providerInstanceId.trim();
  const model = form.model.trim();
  const localWorktreePath = form.localWorktreePath.trim();
  const baseBranch = form.baseBranch.trim();

  if (!title || !prompt || !providerInstanceId || !model) {
    return null;
  }
  if (form.targetType === "project" && !projectId) {
    return null;
  }
  if (form.targetType === "project" && form.workspaceMode === "worktree" && !baseBranch) {
    return null;
  }

  const modelSelection: ModelSelection = createModelSelection(
    ProviderInstanceId.make(providerInstanceId),
    model,
  );
  const workspace: ScheduledTaskWorkspace =
    form.workspaceMode === "worktree"
      ? {
          mode: "worktree",
          baseBranch,
          startFromOrigin: form.startFromOrigin,
        }
      : {
          mode: "local",
          worktreePath: localWorktreePath || null,
        };

  return {
    title,
    prompt,
    enabled: form.enabled,
    cadence: form.cadence,
    target:
      form.targetType === "standalone"
        ? { type: "standalone" }
        : {
            type: "project",
            projectId: ProjectId.make(projectId),
            workspace,
          },
    modelSelection,
    runtimeMode: form.runtimeMode,
    interactionMode: form.interactionMode,
  };
}

function relativeDate(value: string | null, nowMs: number) {
  if (!value) return "Never";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  const deltaSeconds = Math.max(1, Math.round((nowMs - timestamp) / 1000));
  if (deltaSeconds < 60) return "Just now";
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 48) return `${deltaHours}h ago`;
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d ago`;
}

function scheduledDate(value: string | null, nowMs: number) {
  if (!value) return "Not scheduled";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  const deltaMinutes = Math.ceil((timestamp - nowMs) / 60_000);
  if (deltaMinutes <= 0) return "Due now";
  if (deltaMinutes < 60) return `In ${deltaMinutes}m`;
  const deltaHours = Math.ceil(deltaMinutes / 60);
  if (deltaHours < 48) return `In ${deltaHours}h`;
  return `In ${Math.ceil(deltaHours / 24)}d`;
}

function runStateLabel(task: ScheduledTaskSnapshot) {
  switch (task.runState) {
    case "pending_manual_run":
      return "Manual run required";
    case "scheduled":
      return "Scheduled";
    case "disabled":
      return "Disabled";
    case "running":
      return "Running";
  }
}

function runStateVariant(task: ScheduledTaskSnapshot): ComponentProps<typeof Badge>["variant"] {
  switch (task.runState) {
    case "scheduled":
      return "success";
    case "running":
      return "info";
    case "disabled":
      return "outline";
    case "pending_manual_run":
      return "warning";
  }
}

function resultBadge(task: ScheduledTaskSnapshot) {
  if (task.lastStatus === "succeeded") {
    return <Badge variant="success">Succeeded</Badge>;
  }
  if (task.lastStatus === "failed") {
    return <Badge variant="error">Failed</Badge>;
  }
  return <Badge variant="outline">No runs</Badge>;
}

function FieldLabel({ children }: { readonly children: ReactNode }) {
  return <label className="text-[11px] font-medium text-muted-foreground">{children}</label>;
}

function ScheduledTaskDialog({
  open,
  task,
  defaults,
  projects,
  providers,
  onOpenChange,
  onSubmit,
}: {
  readonly open: boolean;
  readonly task: ScheduledTaskSnapshot | null;
  readonly defaults: Parameters<typeof formFromTask>[1];
  readonly projects: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly workspaceRoot: string;
  }>;
  readonly providers: ReadonlyArray<ProviderOption>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (input: ScheduledTaskCreateInput) => Promise<boolean>;
}) {
  const [form, setForm] = useState<FormState>(() => formFromTask(task, defaults));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(formFromTask(task, defaults));
      setSaving(false);
    }
  }, [defaults, open, task]);

  const selectedProvider =
    providers.find((provider) => provider.instanceId === form.providerInstanceId) ?? null;
  const modelOptions = selectedProvider?.models ?? [];
  const modelValues = new Set(modelOptions.map((model) => model.slug));
  const validInput = toScheduledTaskInput(form);

  const submit = async () => {
    const input = toScheduledTaskInput(form);
    if (!input) return;
    setSaving(true);
    const ok = await onSubmit(input);
    setSaving(false);
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{task ? "Edit scheduled task" : "Create scheduled task"}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <FieldLabel>Title</FieldLabel>
              <Input
                nativeInput
                value={form.title}
                onChange={(event) => {
                  const title = event.currentTarget.value;
                  setForm((current) => ({ ...current, title }));
                }}
              />
            </div>
            <div className="space-y-1.5">
              <FieldLabel>Cadence</FieldLabel>
              <Select
                value={form.cadence}
                onValueChange={(value) => {
                  if (CADENCES.includes(value as ScheduledTaskCadence)) {
                    setForm((current) => ({ ...current, cadence: value as ScheduledTaskCadence }));
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue>{CADENCE_LABELS[form.cadence]}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {CADENCES.map((cadence) => (
                    <SelectItem hideIndicator key={cadence} value={cadence}>
                      {CADENCE_LABELS[cadence]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <FieldLabel>Prompt</FieldLabel>
            <Textarea
              value={form.prompt}
              onChange={(event) => {
                const prompt = event.currentTarget.value;
                setForm((current) => ({ ...current, prompt }));
              }}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <FieldLabel>Chat type</FieldLabel>
              <Select
                value={form.targetType}
                onValueChange={(value) => {
                  if (value === "standalone" || value === "project") {
                    setForm((current) => ({
                      ...current,
                      targetType: value,
                      projectId: value === "project" ? current.projectId || defaults.projectId : "",
                    }));
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue>{TARGET_TYPE_LABELS[form.targetType]}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="standalone">
                    Standalone chat
                  </SelectItem>
                  <SelectItem hideIndicator disabled={projects.length === 0} value="project">
                    Project chat
                  </SelectItem>
                </SelectPopup>
              </Select>
            </div>
            <div className="space-y-1.5">
              <FieldLabel>Provider</FieldLabel>
              <Select
                value={form.providerInstanceId || NO_PROVIDER_VALUE}
                onValueChange={(value) => {
                  if (typeof value !== "string" || value === NO_PROVIDER_VALUE) return;
                  const nextProvider =
                    providers.find((provider) => provider.instanceId === value) ?? null;
                  setForm((current) => ({
                    ...current,
                    providerInstanceId: value,
                    model: defaultModelForProvider(nextProvider),
                  }));
                }}
              >
                <SelectTrigger>
                  <SelectValue>
                    {providers.find((provider) => provider.instanceId === form.providerInstanceId)
                      ? providerLabel(
                          providers.find(
                            (provider) => provider.instanceId === form.providerInstanceId,
                          )!,
                        )
                      : "Select provider"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {providers.length === 0 ? (
                    <SelectItem hideIndicator disabled value={NO_PROVIDER_VALUE}>
                      No providers available
                    </SelectItem>
                  ) : (
                    providers.map((provider) => (
                      <SelectItem
                        hideIndicator
                        key={provider.instanceId}
                        value={provider.instanceId}
                      >
                        {providerLabel(provider)}
                      </SelectItem>
                    ))
                  )}
                </SelectPopup>
              </Select>
            </div>
          </div>

          {form.targetType === "project" ? (
            <div className="space-y-1.5">
              <FieldLabel>Project</FieldLabel>
              <Select
                value={form.projectId || NO_PROJECT_VALUE}
                onValueChange={(value) => {
                  if (typeof value === "string" && value !== NO_PROJECT_VALUE) {
                    setForm((current) => ({ ...current, projectId: value }));
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue>
                    {projects.find((project) => project.id === form.projectId)?.title ??
                      "Select project"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {projects.length === 0 ? (
                    <SelectItem hideIndicator disabled value={NO_PROJECT_VALUE}>
                      No projects available
                    </SelectItem>
                  ) : (
                    projects.map((project) => (
                      <SelectItem hideIndicator key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))
                  )}
                </SelectPopup>
              </Select>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <FieldLabel>Model</FieldLabel>
              {modelOptions.length > 0 ? (
                <Select
                  value={form.model}
                  onValueChange={(value) => {
                    if (typeof value === "string") {
                      setForm((current) => ({ ...current, model: value }));
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue>{form.model}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {!modelValues.has(form.model) && form.model ? (
                      <SelectItem hideIndicator value={form.model}>
                        {form.model}
                      </SelectItem>
                    ) : null}
                    {modelOptions.map((model) => (
                      <SelectItem hideIndicator key={model.slug} value={model.slug}>
                        {model.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : (
                <Input
                  nativeInput
                  value={form.model}
                  onChange={(event) => {
                    const model = event.currentTarget.value;
                    setForm((current) => ({ ...current, model }));
                  }}
                />
              )}
            </div>
            <div className="space-y-1.5">
              <FieldLabel>Runtime mode</FieldLabel>
              <Select
                value={form.runtimeMode}
                onValueChange={(value) => {
                  if (RUNTIME_MODES.includes(value as RuntimeMode)) {
                    setForm((current) => ({ ...current, runtimeMode: value as RuntimeMode }));
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue>{RUNTIME_MODE_LABELS[form.runtimeMode]}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {RUNTIME_MODES.map((mode) => (
                    <SelectItem hideIndicator key={mode} value={mode}>
                      {RUNTIME_MODE_LABELS[mode]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <FieldLabel>Interaction mode</FieldLabel>
              <Select
                value={form.interactionMode}
                onValueChange={(value) => {
                  if (INTERACTION_MODES.includes(value as ProviderInteractionMode)) {
                    setForm((current) => ({
                      ...current,
                      interactionMode: value as ProviderInteractionMode,
                    }));
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue>{INTERACTION_MODE_LABELS[form.interactionMode]}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {INTERACTION_MODES.map((mode) => (
                    <SelectItem hideIndicator key={mode} value={mode}>
                      {INTERACTION_MODE_LABELS[mode]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            {form.targetType === "project" ? (
              <div className="space-y-1.5">
                <FieldLabel>Workspace mode</FieldLabel>
                <Select
                  value={form.workspaceMode}
                  onValueChange={(value) => {
                    if (value === "local" || value === "worktree") {
                      setForm((current) => ({ ...current, workspaceMode: value }));
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue>
                      {form.workspaceMode === "worktree" ? "New worktree" : "Local"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    <SelectItem hideIndicator value="local">
                      Local
                    </SelectItem>
                    <SelectItem hideIndicator value="worktree">
                      New worktree
                    </SelectItem>
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
          </div>

          {form.targetType === "project" ? (
            form.workspaceMode === "worktree" ? (
              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <div className="space-y-1.5">
                  <FieldLabel>Base branch</FieldLabel>
                  <Input
                    nativeInput
                    value={form.baseBranch}
                    onChange={(event) => {
                      const baseBranch = event.currentTarget.value;
                      setForm((current) => ({ ...current, baseBranch }));
                    }}
                  />
                </div>
                <label className="flex items-center gap-2 self-end pb-1 text-sm text-foreground">
                  <Switch
                    checked={form.startFromOrigin}
                    onCheckedChange={(checked) =>
                      setForm((current) => ({ ...current, startFromOrigin: Boolean(checked) }))
                    }
                  />
                  Start from origin
                </label>
              </div>
            ) : (
              <div className="space-y-1.5">
                <FieldLabel>Local worktree path</FieldLabel>
                <Input
                  nativeInput
                  placeholder="Use project root"
                  value={form.localWorktreePath}
                  onChange={(event) => {
                    const localWorktreePath = event.currentTarget.value;
                    setForm((current) => ({
                      ...current,
                      localWorktreePath,
                    }));
                  }}
                />
              </div>
            )
          ) : null}

          <label className="flex items-center gap-2 text-sm text-foreground">
            <Switch
              checked={form.enabled}
              onCheckedChange={(checked) =>
                setForm((current) => ({ ...current, enabled: Boolean(checked) }))
              }
            />
            Enabled
          </label>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!validInput || saving} onClick={() => void submit()}>
            {task ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function ScheduledTasksSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();
  const nowMs = useRelativeTimeTick(15_000);
  const allProjects = useProjects();
  const tasks = useAtomValue(primaryServerScheduledTasksAtom);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const settings = useAtomValue(primaryServerSettingsAtom);
  const createTask = useAtomCommand(serverEnvironment.scheduledTasksCreate, {
    reportFailure: true,
  });
  const updateTask = useAtomCommand(serverEnvironment.scheduledTasksUpdate, {
    reportFailure: true,
  });
  const deleteTask = useAtomCommand(serverEnvironment.scheduledTasksDelete, {
    reportFailure: true,
  });
  const runTask = useAtomCommand(serverEnvironment.scheduledTasksRunNow, {
    reportFailure: true,
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTaskSnapshot | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  const projects = useMemo(
    () =>
      environmentId === null
        ? []
        : allProjects
            .filter((project) => project.environmentId === environmentId)
            .toSorted((left, right) => left.title.localeCompare(right.title)),
    [allProjects, environmentId],
  );
  const visibleProviders = useMemo(
    () =>
      providers
        .filter((provider) => provider.enabled && provider.availability !== "unavailable")
        .toSorted((left, right) => providerLabel(left).localeCompare(providerLabel(right))),
    [providers],
  );
  const defaultProvider = visibleProviders[0] ?? null;
  const defaults = useMemo(
    () => ({
      targetType: (projects.length > 0 ? "project" : "standalone") as ScheduledTaskTarget["type"],
      projectId: projects[0]?.id ?? "",
      providerInstanceId: defaultProvider?.instanceId ?? "codex",
      model: defaultModelForProvider(defaultProvider),
      workspaceMode: settings.defaultThreadEnvMode,
      startFromOrigin: settings.newWorktreesStartFromOrigin,
    }),
    [
      defaultProvider,
      projects,
      settings.defaultThreadEnvMode,
      settings.newWorktreesStartFromOrigin,
    ],
  );
  const projectTitles = useMemo(
    () => new Map(projects.map((project) => [project.id, project.title])),
    [projects],
  );

  const openCreate = () => {
    setEditingTask(null);
    setDialogOpen(true);
  };
  const openEdit = (task: ScheduledTaskSnapshot) => {
    setEditingTask(task);
    setDialogOpen(true);
  };

  const handleSubmit = async (input: ScheduledTaskCreateInput) => {
    if (environmentId === null) return false;
    const result = editingTask
      ? await updateTask({ environmentId, input: { id: editingTask.id, patch: input } })
      : await createTask({ environmentId, input });
    return result._tag === "Success";
  };
  const handleToggle = async (task: ScheduledTaskSnapshot, enabled: boolean) => {
    if (environmentId === null) return;
    setBusyTaskId(task.id);
    await updateTask({ environmentId, input: { id: task.id, patch: { enabled } } });
    setBusyTaskId(null);
  };
  const handleDelete = async (task: ScheduledTaskSnapshot) => {
    if (!window.confirm(`Delete scheduled task "${task.title}"?`)) return;
    if (environmentId === null) return;
    setBusyTaskId(task.id);
    await deleteTask({ environmentId, input: { id: task.id } });
    setBusyTaskId(null);
  };
  const handleRunNow = async (task: ScheduledTaskSnapshot) => {
    if (environmentId === null) return;
    setBusyTaskId(task.id);
    const result = await runTask({ environmentId, input: { id: task.id } });
    setBusyTaskId(null);
    if (result._tag === "Success" && result.value.task.lastThreadId) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: result.value.task.lastThreadId },
      });
    }
  };

  return (
    <SettingsPageContainer className="max-w-5xl">
      <SettingsSection
        title="Scheduled Tasks"
        icon={<CalendarClockIcon className="size-3.5" />}
        headerAction={
          <Button size="xs" onClick={openCreate} disabled={environmentId === null}>
            <PlusIcon className="size-3.5" />
            New
          </Button>
        }
      >
        {tasks.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
            <CalendarClockIcon className="size-8 text-muted-foreground/50" />
            <div>
              <div className="text-sm font-medium text-foreground">No scheduled tasks</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Create one and run it manually once to seed its schedule.
              </div>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {tasks.map((task) => {
              const busy = busyTaskId === task.id || task.runState === "running";
              const targetTitle =
                task.target.type === "standalone"
                  ? "Standalone chat"
                  : (projectTitles.get(task.target.projectId) ?? task.target.projectId);
              return (
                <div key={task.id} className="px-4 py-4 sm:px-5">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <h3 className="truncate text-sm font-semibold text-foreground">
                          {task.title}
                        </h3>
                        <Badge variant={runStateVariant(task)}>{runStateLabel(task)}</Badge>
                        <Badge variant="outline">{CADENCE_LABELS[task.cadence]}</Badge>
                        {resultBadge(task)}
                      </div>
                      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 xl:grid-cols-4">
                        <span className="truncate">Target: {targetTitle}</span>
                        <span>Last: {relativeDate(task.lastFinishedAt, nowMs)}</span>
                        <span>Next: {scheduledDate(task.nextRunAt, nowMs)}</span>
                        <span className="truncate">
                          Thread:{" "}
                          {task.lastThreadId && environmentId ? (
                            <Link
                              className="text-foreground underline-offset-2 hover:underline"
                              to="/$environmentId/$threadId"
                              params={{ environmentId, threadId: task.lastThreadId }}
                            >
                              {task.lastThreadId.slice(0, 8)}
                            </Link>
                          ) : (
                            "None"
                          )}
                        </span>
                      </div>
                      {task.lastError ? (
                        <p className="line-clamp-2 text-xs text-destructive-foreground">
                          {task.lastError}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <Switch
                        checked={task.enabled}
                        disabled={busy}
                        aria-label={
                          task.enabled ? "Disable scheduled task" : "Enable scheduled task"
                        }
                        onCheckedChange={(checked) => void handleToggle(task, Boolean(checked))}
                      />
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void handleRunNow(task)}
                      >
                        <PlayIcon className="size-3.5" />
                        Run
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label="Edit task"
                        onClick={() => openEdit(task)}
                      >
                        <Edit2Icon className="size-3.5" />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className={cn("text-muted-foreground hover:text-destructive-foreground")}
                        aria-label="Delete task"
                        disabled={busy}
                        onClick={() => void handleDelete(task)}
                      >
                        <Trash2Icon className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>

      <ScheduledTaskDialog
        open={dialogOpen}
        task={editingTask}
        defaults={defaults}
        projects={projects}
        providers={visibleProviders}
        onOpenChange={setDialogOpen}
        onSubmit={handleSubmit}
      />
    </SettingsPageContainer>
  );
}
