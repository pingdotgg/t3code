import { useAtomValue } from "@effect/atom-react";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { useNavigate } from "@tanstack/react-router";
import { CalendarClockIcon, PencilIcon, PlayIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectId,
  type ScheduledTask,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { Switch } from "../ui/switch";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ScheduledRelativeLabel, scheduleLabel } from "../settings/ScheduledTasksSettings";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

import { readEnvironmentScope } from "../../state/session";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuTrigger,
} from "../ui/menu";
import { StatusDot, type StatusDotTone } from "../ui/status-dot";

function reportFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
}

function TaskTimingLabel({ task }: { task: ScheduledTask }) {
  return (
    <>
      {scheduleLabel(task.schedule)}
      {task.blockedByPolicy !== undefined ? (
        ` · ${task.blockedByPolicy}`
      ) : task.enabled && task.nextRunAt !== null ? (
        <>
          {" · next "}
          <ScheduledRelativeLabel value={task.nextRunAt} />
        </>
      ) : task.enabled ? (
        ""
      ) : (
        " · paused"
      )}
    </>
  );
}

const STATUS_DOT_TONE: Record<ScheduledTask["lastRunStatus"], StatusDotTone> = {
  never: "neutral",
  running: "info",
  succeeded: "success",
  failed: "danger",
};

export function ThreadAutomationsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const canOperate = useAtomValue(
    serverEnvironment.runScheduledTaskNow.permissionAtom(props.environmentId),
  );
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} }),
  );
  const setTaskEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "thread automation toggle",
  });
  const runTaskNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "thread automation run now",
  });
  const navigate = useNavigate();
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  const boundTasks = (tasksQuery.data?.tasks ?? []).filter(
    (task) => task.threadId === props.threadId,
  );

  const nextRun = boundTasks
    .filter((task) => task.enabled && task.nextRunAt !== null)
    .map((task) => task.nextRunAt!)
    .sort()[0];

  const toggleEnabled = async (task: ScheduledTask, enabled: boolean) => {
    if (
      busyTaskId !== null ||
      !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    setBusyTaskId(task.id);
    const result = await setTaskEnabled({
      environmentId: props.environmentId,
      input: { id: task.id, enabled },
    });
    setBusyTaskId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not update automation", squashAtomCommandFailure(result));
    }
  };

  const runNow = async (task: ScheduledTask) => {
    if (
      busyTaskId !== null ||
      !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    setBusyTaskId(task.id);
    const result = await runTaskNow({
      environmentId: props.environmentId,
      input: { id: task.id },
    });
    setBusyTaskId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not run automation", squashAtomCommandFailure(result));
    }
  };

  return (
    <ThreadDetailsSection
      title="Automations"
      summary={
        boundTasks.length ? (
          <>
            {boundTasks.length}
            {nextRun ? (
              <>
                , next <ScheduledRelativeLabel value={nextRun} />
              </>
            ) : null}
          </>
        ) : (
          "None scheduled"
        )
      }
      action={
        <ThreadDetailsControl
          part="icon"
          aria-label="Manage scheduled tasks"
          onClick={() =>
            void navigate({
              to: "/settings/scheduled-tasks",
              search: { environmentId: props.environmentId },
            })
          }
        >
          <Settings2Icon />
        </ThreadDetailsControl>
      }
      data-thread-automations-panel
    >
      {boundTasks.length === 0 && tasksQuery.error === null ? (
        <div className="flex h-9 items-center gap-2.5 px-2.5 text-caption text-dim-foreground">
          <CalendarClockIcon className="size-4" />
          No automations scheduled
        </div>
      ) : null}
      <div className="max-h-[13.5rem] overflow-y-auto">
        {boundTasks.map((task) => (
          <Menu key={task.id}>
            <div className="flex min-h-9 items-center pe-1">
              <MenuTrigger render={<ThreadDetailsControl multiline />}>
                <span className="relative shrink-0">
                  <CalendarClockIcon className="size-4 text-muted-foreground" />
                  {task.enabled ? (
                    <span className="absolute -right-0.5 -top-0.5">
                      <StatusDot tone={STATUS_DOT_TONE[task.lastRunStatus]} />
                    </span>
                  ) : null}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-meta">{task.title}</span>
                  <span className="truncate text-caption text-muted-foreground">
                    {task.blockedByPolicy ??
                      (!task.enabled
                        ? "Paused"
                        : task.lastRunStatus === "running"
                          ? "Running"
                          : scheduleLabel(task.schedule))}
                  </span>
                </span>
              </MenuTrigger>
              {task.schedule.type !== "webhook" ? (
                <ThreadDetailsControl
                  part="icon"
                  aria-label={`Run ${task.title} now`}
                  disabled={!canOperate || busyTaskId !== null || task.lastRunStatus === "running"}
                  onClick={() => void runNow(task)}
                >
                  <PlayIcon />
                </ThreadDetailsControl>
              ) : null}
              <Switch
                size="sm"
                checked={task.enabled}
                disabled={!canOperate || busyTaskId !== null}
                aria-label={task.enabled ? `Pause ${task.title}` : `Resume ${task.title}`}
                onCheckedChange={(enabled) => void toggleEnabled(task, enabled)}
              />
            </div>
            <MenuPopup side="right" align="start">
              <MenuItem
                onClick={() =>
                  void navigate({
                    to: "/settings/scheduled-tasks",
                    search: { environmentId: props.environmentId, taskId: task.id },
                  })
                }
              >
                <PencilIcon />
                <MenuItemLabel>Edit {task.title}</MenuItemLabel>
              </MenuItem>
              {task.schedule.type !== "webhook" ? (
                <MenuItem
                  disabled={!canOperate || busyTaskId !== null || task.lastRunStatus === "running"}
                  onClick={() => void runNow(task)}
                >
                  <PlayIcon />
                  <MenuItemLabel>Run {task.title} now</MenuItemLabel>
                </MenuItem>
              ) : null}
              <MenuCheckboxItem
                variant="switch"
                checked={task.enabled}
                disabled={!canOperate || busyTaskId !== null}
                aria-label={task.enabled ? `Pause ${task.title}` : `Resume ${task.title}`}
                onCheckedChange={(enabled) => void toggleEnabled(task, enabled)}
              >
                Enabled
              </MenuCheckboxItem>
            </MenuPopup>
          </Menu>
        ))}
      </div>
      {tasksQuery.error !== null ? (
        <p className="px-2 py-1 text-caption text-error-foreground">
          Could not load automations: {tasksQuery.error}
        </p>
      ) : null}
    </ThreadDetailsSection>
  );
}

const STATUS_BADGES: Partial<
  Record<
    ScheduledTask["lastRunStatus"],
    { readonly label: string; readonly variant: "success" | "error" | "info" }
  >
> = {
  running: { label: "running", variant: "info" },
  succeeded: { label: "succeeded", variant: "success" },
  failed: { label: "failed", variant: "error" },
};

/**
 * The header's automations button (pen mlsUZ): the project's scheduled tasks
 * with their schedule, last result and Run now, and a way to manage them all.
 * Scoped to the project, where thread details lists only the tasks bound to
 * the thread. Renders nothing when the project has none.
 */
export function ProjectAutomationsHeaderControl(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectName: string;
}) {
  const canOperate = useAtomValue(
    serverEnvironment.runScheduledTaskNow.permissionAtom(props.environmentId),
  );
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} }),
  );
  const runTaskNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "project automation run now",
  });
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const tasks = (tasksQuery.data?.tasks ?? []).filter((task) => task.projectId === props.projectId);
  if (tasks.length === 0) return null;

  const manage = (taskId?: ScheduledTask["id"]) => {
    setOpen(false);
    void navigate({
      to: "/settings/scheduled-tasks",
      search: { environmentId: props.environmentId, ...(taskId ? { taskId } : {}) },
    });
  };

  const runNow = async (task: ScheduledTask) => {
    if (
      busyTaskId !== null ||
      !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    setBusyTaskId(task.id);
    const result = await runTaskNow({
      environmentId: props.environmentId,
      input: { id: task.id },
    });
    setBusyTaskId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not run automation", squashAtomCommandFailure(result));
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger render={<span className="flex shrink-0" />}>
          <PopoverTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label="Automations" />}
          >
            <CalendarClockIcon />
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipPopup side="bottom">Automations</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" width="lg" padding="compact">
        <div className="flex items-baseline justify-between gap-3 px-1 pb-1.5">
          <p className="text-label text-strong-foreground">Automations</p>
          <span className="min-w-0 truncate text-meta text-dim-foreground">
            {props.projectName}
          </span>
        </div>
        <ul className="m-0 flex list-none flex-col p-0">
          {tasks.map((task) => {
            const badge = STATUS_BADGES[task.lastRunStatus];
            return (
              <li
                key={task.id}
                className="group flex min-w-0 items-center gap-2.5 rounded-item px-1 py-1.5"
              >
                <CalendarClockIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-label text-foreground">{task.title}</p>
                  <p className="flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
                    <span className="min-w-0 truncate">
                      <TaskTimingLabel task={task} />
                    </span>
                    {badge ? (
                      <Badge variant={badge.variant} size="sm">
                        {badge.label}
                      </Badge>
                    ) : null}
                  </p>
                </div>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Edit ${task.title}`}
                        onClick={() => manage(task.id)}
                      />
                    }
                  >
                    <PencilIcon />
                  </TooltipTrigger>
                  <TooltipPopup>Edit automation</TooltipPopup>
                </Tooltip>
                {task.schedule.type !== "webhook" ? (
                  <Button
                    variant="secondary"
                    size="xs"
                    disabled={
                      !canOperate || busyTaskId !== null || task.lastRunStatus === "running"
                    }
                    onClick={() => void runNow(task)}
                  >
                    <PlayIcon />
                    Run now
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {tasksQuery.error !== null ? (
          <p className="px-1 py-1.5 text-caption text-error-foreground">
            Could not load automations: {tasksQuery.error}
          </p>
        ) : null}
        <div className="mt-1.5 border-t border-hairline pt-2">
          <Button variant="secondary" size="sm" onClick={() => manage()}>
            <Settings2Icon />
            Manage scheduled tasks
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
