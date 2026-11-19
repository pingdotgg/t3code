import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages, Var } from "gt-react";
import { m as resolveMessage } from "~/i18n/messages";
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
import { ScheduledRelativeLabel } from "../settings/ScheduledTasksSettings";
import { scheduleLabel } from "../settings/scheduledTasksSettings.logic";
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

function reportFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: thrownErrorMessage(error, resolveMessage) ?? String(error),
    }),
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
    useMessages(),
  );
  const setTaskEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "thread automation toggle",
  });
  const runTaskNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "thread automation run now",
  });
  const navigate = useNavigate();
  const gt = useGT();
  const m = useMessages();
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
      reportFailure(gt("Could not update automation"), squashAtomCommandFailure(result));
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
      reportFailure(gt("Could not run automation"), squashAtomCommandFailure(result));
    }
  };

  return (
    <ThreadDetailsSection
      title={gt("Automations")}
      summary={
        boundTasks.length ? (
          nextRun ? (
            <T>
              <Var>{boundTasks.length}</Var>, next <ScheduledRelativeLabel value={nextRun} />
            </T>
          ) : (
            boundTasks.length
          )
        ) : (
          gt("None scheduled", { $context: "automations" })
        )
      }
      action={
        <ThreadDetailsControl
          part="icon"
          aria-label={gt("Manage scheduled tasks")}
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
          <T>No automations scheduled</T>
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
                        ? gt("Paused", { $context: "automation state" })
                        : task.lastRunStatus === "running"
                          ? gt("Running", { $context: "automation state" })
                          : scheduleLabel(
                              task.schedule,
                              tasksQuery.data?.timeZone,
                              task.nextRunAt,
                              m,
                            ))}
                  </span>
                </span>
              </MenuTrigger>
              {task.schedule.type !== "webhook" ? (
                <ThreadDetailsControl
                  part="icon"
                  aria-label={gt("Run {title} now", { title: task.title })}
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
                aria-label={
                  task.enabled
                    ? gt("Pause {title}", { title: task.title })
                    : gt("Resume {title}", { title: task.title })
                }
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
                <MenuItemLabel>{gt("Edit {title}", { title: task.title })}</MenuItemLabel>
              </MenuItem>
              {task.schedule.type !== "webhook" ? (
                <MenuItem
                  disabled={!canOperate || busyTaskId !== null || task.lastRunStatus === "running"}
                  onClick={() => void runNow(task)}
                >
                  <PlayIcon />
                  <MenuItemLabel>{gt("Run {title} now", { title: task.title })}</MenuItemLabel>
                </MenuItem>
              ) : null}
              <MenuCheckboxItem
                variant="switch"
                checked={task.enabled}
                disabled={!canOperate || busyTaskId !== null}
                aria-label={
                  task.enabled
                    ? gt("Pause {title}", { title: task.title })
                    : gt("Resume {title}", { title: task.title })
                }
                onCheckedChange={(enabled) => void toggleEnabled(task, enabled)}
              >
                <T context="automation state">Enabled</T>
              </MenuCheckboxItem>
            </MenuPopup>
          </Menu>
        ))}
      </div>
      {tasksQuery.error !== null ? (
        <p className="px-2 py-1 text-caption text-error-foreground">
          <T>
            Could not load automations: <Var>{tasksQuery.error}</Var>
          </T>
        </p>
      ) : null}
    </ThreadDetailsSection>
  );
}

export function ProjectAutomationsHeaderControl(_props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectName: string;
}) {
  return null;
}
