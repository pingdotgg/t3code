import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { useNavigate } from "@tanstack/react-router";
import { CalendarClockIcon, PencilIcon, PlayIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";
import type { EnvironmentId, ScheduledTask, ThreadId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { cn } from "../../lib/utils";
import { relativeLabel, scheduleLabel } from "../settings/ScheduledTasksSettings";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

const STATUS_DOT_CLASS: Record<ScheduledTask["lastRunStatus"], string> = {
  never: "bg-muted-foreground/40",
  running: "animate-pulse bg-sky-500",
  succeeded: "bg-emerald-500",
  failed: "bg-destructive",
};

/**
 * Thread details panel section listing the automations (scheduled tasks) bound
 * to this thread. Fed by the live scheduled-task subscription, so run status
 * and next-run times update as the scheduler works — no manual refresh.
 * Renders nothing when the thread has no bound automations.
 */
export function ThreadAutomationsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly alwaysVisible?: boolean;
}) {
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
  // A load error must not look like "no automations" — this thread may have
  // tasks whose controls would silently vanish. Only hide the section when we
  // positively know there is nothing bound to it. A customization set to
  // "always" keeps the heading instead, with a terse empty state.
  if (tasksQuery.error === null && boundTasks.length === 0 && !props.alwaysVisible) return null;

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
    if (busyTaskId !== null) return;
    setBusyTaskId(task.id);
    // Partial update: only the enabled flag changes, so a toggle can never
    // revert concurrent edits made to the task elsewhere.
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
    if (busyTaskId !== null) return;
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
      headingId="thread-details-automations-heading"
      title="Automations"
      data-thread-automations-panel
      actions={
        <Tooltip>
          <TooltipTrigger
            render={
              <ThreadDetailsControl
                size="icon-xs"
                variant="ghost"
                part="icon"
                aria-label="Manage scheduled tasks"
                onClick={() =>
                  void navigate({
                    to: "/settings/scheduled-tasks",
                    search: { environmentId: props.environmentId },
                  })
                }
              >
                <Settings2Icon className="size-3.5" />
              </ThreadDetailsControl>
            }
          />
          <TooltipPopup>Manage scheduled tasks</TooltipPopup>
        </Tooltip>
      }
    >
      {tasksQuery.error !== null ? (
        <p className="px-2.5 py-1.5 text-[11px] text-destructive">
          Could not load automations: {tasksQuery.error}
        </p>
      ) : boundTasks.length === 0 ? (
        <p className="px-2.5 py-1.5 text-[11px] text-muted-foreground">
          {tasksQuery.data === null ? "Loading automations…" : "No automations."}
        </p>
      ) : null}

      <ul className="m-0 list-none p-0">
        {boundTasks.map((task) => (
          <li key={task.id} className="group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5">
            <CalendarClockIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    STATUS_DOT_CLASS[task.lastRunStatus],
                  )}
                  aria-hidden
                />
                <span className="truncate text-[13px] font-medium text-foreground/80">
                  {task.title}
                </span>
              </div>
              <p className="truncate text-[11px] text-muted-foreground">
                {scheduleLabel(task.schedule)}
                {task.enabled && task.nextRunAt !== null
                  ? ` · next ${relativeLabel(task.nextRunAt)}`
                  : task.enabled
                    ? ""
                    : " · paused"}
              </p>
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <ThreadDetailsControl
                    size="icon-xs"
                    variant="ghost"
                    part="icon"
                    aria-label={`Edit ${task.title}`}
                    onClick={() =>
                      void navigate({
                        to: "/settings/scheduled-tasks",
                        search: { environmentId: props.environmentId, taskId: task.id },
                      })
                    }
                  >
                    <PencilIcon className="size-3.5" />
                  </ThreadDetailsControl>
                }
              />
              <TooltipPopup>Edit automation</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <ThreadDetailsControl
                    size="icon-xs"
                    variant="ghost"
                    part="icon"
                    aria-label={`Run ${task.title} now`}
                    disabled={busyTaskId !== null || task.lastRunStatus === "running"}
                    onClick={() => void runNow(task)}
                  >
                    <PlayIcon className="size-3.5" />
                  </ThreadDetailsControl>
                }
              />
              <TooltipPopup>Run now</TooltipPopup>
            </Tooltip>
            <Switch
              checked={task.enabled}
              disabled={busyTaskId !== null}
              aria-label={task.enabled ? `Pause ${task.title}` : `Resume ${task.title}`}
              onCheckedChange={(enabled) => void toggleEnabled(task, enabled)}
            />
          </li>
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}
