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

import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ScheduledRelativeLabel, scheduleLabel } from "../settings/ScheduledTasksSettings";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

import { readEnvironmentScope } from "../../state/session";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
import { THREAD_DETAILS_PANEL_META_CLASS } from "./threadDetailsPanelStyles";

const STATUS_DOT_TONE: Record<ScheduledTask["lastRunStatus"], StatusDotTone> = {
  never: "neutral",
  running: "info",
  succeeded: "success",
  failed: "danger",
};

function taskScheduleLine(task: ScheduledTask) {
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

  if (tasksQuery.error === null && boundTasks.length === 0) return null;

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
    <ThreadDetailsSection title="Automations" data-thread-automations-panel>
      {tasksQuery.error !== null ? (
        <p className="px-2 py-1 text-caption text-error-foreground">
          Could not load automations: {tasksQuery.error}
        </p>
      ) : null}
      <div className="max-h-[13.5rem] overflow-y-auto">
        {boundTasks.map((task) => (
          <Menu key={task.id}>
            <Tooltip>
              <TooltipTrigger
                render={<MenuTrigger render={<ThreadDetailsControl part="choice" />} />}
              >
                <CalendarClockIcon />
                <MenuItemLabel className="flex-1">{task.title}</MenuItemLabel>
                <span className={THREAD_DETAILS_PANEL_META_CLASS}>
                  <StatusDot tone={STATUS_DOT_TONE[task.lastRunStatus]} />
                  {!task.enabled ? (
                    "Paused"
                  ) : task.nextRunAt !== null ? (
                    <ScheduledRelativeLabel value={task.nextRunAt} />
                  ) : (
                    scheduleLabel(task.schedule)
                  )}
                </span>
              </TooltipTrigger>
              <TooltipPopup>
                <p className="text-meta text-strong-foreground">{task.title}</p>
                <p className="text-dim-foreground">{taskScheduleLine(task)}</p>
              </TooltipPopup>
            </Tooltip>
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
      <ThreadDetailsControl
        aria-label="Manage scheduled tasks"
        onClick={() =>
          void navigate({
            to: "/settings/scheduled-tasks",
            search: { environmentId: props.environmentId },
          })
        }
      >
        <Settings2Icon />
        <MenuItemLabel>Manage scheduled tasks</MenuItemLabel>
      </ThreadDetailsControl>
    </ThreadDetailsSection>
  );
}
