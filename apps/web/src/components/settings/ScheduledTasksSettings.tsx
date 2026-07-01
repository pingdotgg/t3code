import { useAtomValue } from "@effect/atom-react";
import { Clock3Icon, PencilIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type {
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { cn } from "../../lib/utils";
import { formatRelativeTime } from "../../timestampFormat";
import { usePrimarySettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { usePrimaryEnvironment } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsSection, useRelativeTimeTick } from "./settingsLayout";

type ScheduleMode = "fixed" | "interval";
type WorkspaceMode = "root" | "worktree" | "existing_worktree";

interface DraftState {
  readonly editingId: string | null;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly scheduleMode: ScheduleMode;
  readonly intervalMinutes: string;
  readonly timeOfDay: string;
  readonly weekdays: ReadonlySet<number>;
  readonly projectId: string;
  readonly threadId: string;
  readonly workspaceMode: WorkspaceMode;
  readonly baseRef: string;
  readonly existingWorktreePath: string;
  readonly modelKey: string;
  /** Not editable in the dialog, but preserved so editing an agent-created task keeps its modes. */
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/** JS day-of-week (0 = Sunday) rendered Monday-first, matching how people read a week. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
const ALL_WEEKDAYS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 5, 6]);

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
  existingWorktreePath: "",
  modelKey: "",
  runtimeMode: "full-access",
  interactionMode: "default",
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
      <label
        className="flex items-baseline justify-between gap-2 text-xs font-medium text-foreground"
        htmlFor={htmlFor}
      >
        <span>{label}</span>
        {hint ? (
          <span className="font-normal text-[11px] text-muted-foreground/80">{hint}</span>
        ) : null}
      </label>
      {children}
    </div>
  );
}

function modelKey(selection: ModelSelection): string {
  return `${selection.instanceId}:${selection.model}`;
}

function splitModelKey(value: string): ModelSelection | null {
  const index = value.indexOf(":");
  if (index <= 0 || index === value.length - 1) return null;
  return {
    instanceId: ProviderInstanceId.make(value.slice(0, index)),
    model: value.slice(index + 1),
  };
}

function scheduleFromDraft(draft: DraftState): ScheduledTaskSchedule {
  if (draft.scheduleMode === "interval") {
    const minutes = Math.max(1, Number.parseInt(draft.intervalMinutes, 10) || 1);
    return { type: "interval", everyMs: minutes * 60_000 };
  }
  const selectedEveryDay = draft.weekdays.size === 0 || draft.weekdays.size === 7;
  return {
    type: "fixed_time",
    timeOfDay: draft.timeOfDay || "09:00",
    ...(selectedEveryDay ? {} : { weekdays: [...draft.weekdays].toSorted() }),
  };
}

export function scheduleLabel(schedule: ScheduledTaskSchedule): string {
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

export function relativeLabel(value: string | null): string {
  if (!value) return "Not scheduled";
  const relative = formatRelativeTime(value);
  return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
}

function taskToDraft(task: ScheduledTask): DraftState {
  const schedule = task.schedule;
  const weekdays =
    schedule.type === "fixed_time" && schedule.weekdays && schedule.weekdays.length > 0
      ? new Set(schedule.weekdays)
      : new Set(ALL_WEEKDAYS);
  return {
    editingId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    scheduleMode: schedule.type === "interval" ? "interval" : "fixed",
    intervalMinutes:
      schedule.type === "interval"
        ? String(Math.max(1, Math.round(schedule.everyMs / 60_000)))
        : "15",
    timeOfDay: schedule.type === "fixed_time" ? schedule.timeOfDay : "09:00",
    weekdays,
    projectId: task.projectId,
    threadId: task.threadId ?? "",
    workspaceMode: task.workspaceStrategy.type,
    baseRef: task.workspaceStrategy.type === "worktree" ? task.workspaceStrategy.baseRef : "main",
    existingWorktreePath:
      task.workspaceStrategy.type === "existing_worktree"
        ? task.workspaceStrategy.worktreePath
        : "",
    modelKey: modelKey(task.modelSelection),
    runtimeMode: task.runtimeMode,
    interactionMode: task.interactionMode,
  };
}

function statusVariant(status: ScheduledTask["lastRunStatus"]) {
  if (status === "failed") return "error";
  if (status === "succeeded") return "success";
  if (status === "running") return "info";
  return "outline";
}

export function ScheduledTasksSettings() {
  useRelativeTimeTick(15_000);
  const environment = usePrimaryEnvironment();
  const projects = useProjects();
  const settings = usePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  // Live subscription: the server pushes a fresh list after every change
  // (CRUD, run transitions, reschedules), so no manual refresh is needed.
  const tasksQuery = useEnvironmentQuery(
    environment
      ? serverEnvironment.scheduledTasksLive({
          environmentId: environment.environmentId,
          input: {},
        })
      : null,
  );
  const upsertTask = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "scheduled task upsert",
  });
  const deleteTask = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "scheduled task delete",
  });
  const runTaskNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run now",
  });
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const [draft, setDraft] = useState<DraftState>(() => EMPTY_DRAFT);
  const [dialogOpen, setDialogOpen] = useState(false);
  const tasks = tasksQuery.data?.tasks ?? [];
  const selectedProjectTitle = projects.find((project) => project.id === draft.projectId)?.title;

  // The real model picker is keyed by a `${instanceId}:${model}` string, which
  // is exactly how the draft stores its selection.
  const firstInstance = instanceEntries[0];
  const defaultModelKey =
    firstInstance && firstInstance.models[0]
      ? `${firstInstance.instanceId}:${firstInstance.models[0].slug}`
      : "";
  const activeSelection = splitModelKey(draft.modelKey || defaultModelKey);
  const activeInstanceId =
    activeSelection?.instanceId ?? firstInstance?.instanceId ?? ("" as ProviderInstanceId);
  const activeModel = activeSelection?.model ?? "";
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers, activeInstanceId, activeModel),
    [settings, providers, activeInstanceId, activeModel],
  );

  const openForCreate = useCallback(() => {
    setDraft({
      ...EMPTY_DRAFT,
      projectId: projects[0]?.id ?? "",
      modelKey: defaultModelKey,
    });
    setDialogOpen(true);
  }, [defaultModelKey, projects]);

  const openForEdit = useCallback((task: ScheduledTask) => {
    setDraft(taskToDraft(task));
    setDialogOpen(true);
  }, []);

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  const submit = useCallback(async () => {
    if (!environment) return;
    const selection = splitModelKey(draft.modelKey || defaultModelKey);
    if (!draft.title.trim() || !draft.prompt.trim() || !draft.projectId || selection === null) {
      reportFailure("Schedule task is incomplete", "Add a title, prompt, project, and model.");
      return;
    }
    const workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy =
      draft.workspaceMode === "root"
        ? { type: "root" }
        : draft.workspaceMode === "existing_worktree"
          ? { type: "existing_worktree", worktreePath: draft.existingWorktreePath.trim() }
          : { type: "worktree", baseRef: draft.baseRef.trim() || "main", startFromOrigin: true };
    const input: ScheduledTaskUpsertInput = {
      ...(draft.editingId ? { id: draft.editingId as ScheduledTaskId } : {}),
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      enabled: draft.enabled,
      schedule: scheduleFromDraft(draft),
      projectId: draft.projectId as ProjectId,
      threadId: draft.threadId ? (draft.threadId as ThreadId) : null,
      workspaceStrategy,
      modelSelection: selection,
      runtimeMode: draft.runtimeMode,
      interactionMode: draft.interactionMode,
      creationSource: "web",
    };
    const result = await upsertTask({ environmentId: environment.environmentId, input });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Could not save schedule task", squashAtomCommandFailure(result));
      }
      return;
    }
    setDialogOpen(false);
  }, [defaultModelKey, draft, environment, upsertTask]);

  const handleDelete = useCallback(
    async (task: ScheduledTask) => {
      if (!environment) return;
      const result = await deleteTask({
        environmentId: environment.environmentId,
        input: { id: task.id },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure("Could not delete schedule task", squashAtomCommandFailure(result));
      }
    },
    [deleteTask, environment],
  );

  const handleRunNow = useCallback(
    async (task: ScheduledTask) => {
      if (!environment) return;
      const result = await runTaskNow({
        environmentId: environment.environmentId,
        input: { id: task.id },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure("Could not run schedule task", squashAtomCommandFailure(result));
      }
    },
    [environment, runTaskNow],
  );

  // Keep the draft pointed at a real project once projects load, so a freshly
  // opened dialog is never stuck on an empty project select.
  useEffect(() => {
    if (draft.projectId || projects.length === 0) return;
    setDraft((current) => ({
      ...current,
      projectId: projects[0]?.id ?? "",
      modelKey: current.modelKey || defaultModelKey,
    }));
  }, [defaultModelKey, draft.projectId, projects]);

  return (
    <SettingsPageContainer className="max-w-3xl">
      <SettingsSection
        title="Schedule Tasks"
        icon={<Clock3Icon className="size-3.5" />}
        headerAction={
          <Button size="xs" variant="outline" onClick={openForCreate}>
            <PlusIcon className="size-3.5" />
            New
          </Button>
        }
      >
        {tasksQuery.error ? (
          <div className="px-5 py-4 text-xs text-destructive">{tasksQuery.error}</div>
        ) : tasks.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-5 py-12 text-center">
            <div className="grid size-10 place-items-center rounded-full border border-border/70 bg-muted/40 text-muted-foreground">
              <Clock3Icon className="size-4.5" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">No schedule tasks yet</p>
              <p className="mx-auto max-w-xs text-xs text-muted-foreground">
                Create one to run a prompt on a schedule — on an interval or at a fixed time.
              </p>
            </div>
            <Button size="sm" onClick={openForCreate}>
              <PlusIcon className="size-3.5" />
              New task
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {tasks.map((task) => (
              <div key={task.id} className="grid gap-3 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0 space-y-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h3 className="truncate text-sm font-semibold text-foreground">{task.title}</h3>
                    <Badge variant={task.enabled ? "success" : "outline"}>
                      {task.enabled ? "Enabled" : "Paused"}
                    </Badge>
                    <Badge variant={statusVariant(task.lastRunStatus)}>{task.lastRunStatus}</Badge>
                  </div>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{task.prompt}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground/80">
                    <span>{scheduleLabel(task.schedule)}</span>
                    <span>Next: {relativeLabel(task.nextRunAt)}</span>
                    <span>Runs: {task.runCount}</span>
                  </div>
                  {task.lastRunError ? (
                    <p className="text-[11px] text-destructive">{task.lastRunError}</p>
                  ) : null}
                </div>
                <div className="flex items-start gap-1">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Run ${task.title}`}
                          onClick={() => void handleRunNow(task)}
                        >
                          <PlayIcon className="size-4" />
                        </Button>
                      }
                    />
                    <TooltipPopup>Run now</TooltipPopup>
                  </Tooltip>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Edit ${task.title}`}
                    onClick={() => openForEdit(task)}
                  >
                    <PencilIcon className="size-4" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${task.title}`}
                    onClick={() => void handleDelete(task)}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{draft.editingId ? "Edit task" : "New task"}</DialogTitle>
            <DialogDescription>
              Run a prompt automatically — on an interval or at a fixed time.
            </DialogDescription>
          </DialogHeader>

          <DialogPanel className="space-y-5">
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
              <Field label="Project">
                <Select
                  value={draft.projectId}
                  onValueChange={(projectId) =>
                    setDraft((current) => ({ ...current, projectId: projectId ?? "" }))
                  }
                >
                  <SelectTrigger size="sm">
                    <SelectValue placeholder="Select a project">{selectedProjectTitle}</SelectValue>
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

              <Field label="Workspace">
                <Select
                  value={draft.workspaceMode}
                  onValueChange={(value) =>
                    setDraft((current) => ({ ...current, workspaceMode: value as WorkspaceMode }))
                  }
                >
                  <SelectTrigger size="sm">
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
              <Field label="Base ref" htmlFor="scheduled-task-base-ref">
                <Input
                  id="scheduled-task-base-ref"
                  value={draft.baseRef}
                  placeholder="main"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, baseRef: event.target.value }))
                  }
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
                placeholder="What should the agent do each time this runs?"
                value={draft.prompt}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, prompt: event.target.value }))
                }
              />
            </Field>

            <Field label="Model">
              <ProviderModelPicker
                activeInstanceId={activeInstanceId}
                model={activeModel}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                triggerVariant="outline"
                triggerClassName="w-full max-w-none justify-between text-foreground/90 hover:text-foreground"
                onInstanceModelChange={(instanceId, model) =>
                  setDraft((current) => ({ ...current, modelKey: `${instanceId}:${model}` }))
                }
              />
            </Field>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-foreground">Schedule</span>
                <div className="inline-flex items-center gap-0.5 rounded-lg border border-border/70 bg-muted/40 p-0.5">
                  {(
                    [
                      ["fixed", "Daily"],
                      ["interval", "Interval"],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={draft.scheduleMode === mode}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                        draft.scheduleMode === mode
                          ? "bg-background text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => setDraft((current) => ({ ...current, scheduleMode: mode }))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {draft.scheduleMode === "fixed" ? (
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Run at</span>
                    <Input
                      type="time"
                      nativeInput
                      className="w-32"
                      value={draft.timeOfDay}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, timeOfDay: event.target.value }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">on</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {WEEKDAY_ORDER.map((day) => {
                      const selected = draft.weekdays.has(day);
                      return (
                        <button
                          key={day}
                          type="button"
                          aria-pressed={selected}
                          aria-label={WEEKDAY_LABELS[day]}
                          className={cn(
                            "grid size-8 place-items-center rounded-full border text-[11px] font-semibold transition-colors",
                            selected
                              ? "border-primary bg-primary text-primary-foreground shadow-xs"
                              : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                          )}
                          onClick={() =>
                            setDraft((current) => {
                              const weekdays = new Set(current.weekdays);
                              if (weekdays.has(day)) weekdays.delete(day);
                              else weekdays.add(day);
                              return { ...current, weekdays };
                            })
                          }
                        >
                          {WEEKDAY_SHORT[day]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Run every</span>
                  <Input
                    type="number"
                    nativeInput
                    min={1}
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

            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-xs font-medium">Enabled</div>
                <div className="text-[11px] text-muted-foreground">
                  Disabled tasks stay saved but do not run.
                </div>
              </div>
              <Switch
                checked={draft.enabled}
                onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
              />
            </div>
          </DialogPanel>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button size="sm" onClick={() => void submit()}>
              {draft.editingId ? "Save task" : "Create task"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsPageContainer>
  );
}
