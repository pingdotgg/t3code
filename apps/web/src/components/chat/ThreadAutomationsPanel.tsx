import { useAtomValue } from "@effect/atom-react";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { useNavigate } from "@tanstack/react-router";
import { CalendarClockIcon, PencilIcon, PlayIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
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
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuTrigger,
} from "../ui/menu";
import { StatusDot, type StatusDotTone } from "../ui/status-dot";

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

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

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
