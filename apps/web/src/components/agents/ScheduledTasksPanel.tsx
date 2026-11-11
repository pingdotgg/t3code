import { useState, type CSSProperties } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, ClockIcon, PlayIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { useAgentLibrary } from "../../hooks/useAgentLibrary";
import { useClientSettings } from "../../hooks/useSettings";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useScheduledTasks, type EnvironmentScheduledTask } from "../../state/scheduledTasks";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatDayAwareTimestamp, formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { agentColorFor } from "./agents.logic";
import { AgentIcon } from "./AgentIcon";
import { ScheduledTaskEditor } from "./ScheduledTaskEditor";
import { describeSchedule } from "./scheduledTasks.logic";

const LAST_RUN_LABELS = {
  never: "Never",
  running: "Running since",
  succeeded: "Sent",
  failed: "Failed",
} as const;

/** Armed tasks first, soonest run on top; paused and finished ones after, newest edit first. */
function sortTasks(tasks: ReadonlyArray<EnvironmentScheduledTask>) {
  return tasks.toSorted((a, b) => {
    const aNext = a.task.enabled ? a.task.nextRunAt : null;
    const bNext = b.task.enabled ? b.task.nextRunAt : null;
    if (aNext !== null && bNext !== null) return aNext.localeCompare(bNext);
    if (aNext !== null) return -1;
    if (bNext !== null) return 1;
    return b.task.updatedAt.localeCompare(a.task.updatedAt);
  });
}

export function ScheduledTasksPanel({ newForProfileId }: { newForProfileId?: string | undefined }) {
  const tasks = useScheduledTasks();
  const { profiles, available } = useAgentLibrary();
  const [editing, setEditing] = useState<EnvironmentScheduledTask | "new" | null>(
    newForProfileId === undefined ? null : "new",
  );
  const runnable = profiles.filter((profile) => profile.runtimeMode !== "read-only");

  return (
    <div className="scheduled-tasks">
      <header className="scheduled-tasks-header">
        <Link to="/agents" className="agent-mobile-back agent-icon-button">
          <ArrowLeftIcon size={14} /> Agents
        </Link>
        <div>
          <h2>Scheduled tasks</h2>
          <p>Prompts your agents run at a set time or on repeat.</p>
        </div>
        <button
          className="agent-primary"
          disabled={!available || runnable.length === 0}
          onClick={() => setEditing("new")}
        >
          <PlusIcon size={14} />
          New task
        </button>
      </header>
      {tasks.length === 0 ? (
        <p className="agent-empty">
          {runnable.length === 0
            ? "Create an agent first, then schedule prompts for it."
            : "Nothing scheduled. Queue a one-off run, like a deploy tonight, or a routine, like pulling every morning."}
        </p>
      ) : (
        <ul className="scheduled-task-list">
          {sortTasks(tasks).map((entry) => (
            <ScheduledTaskRow
              key={`${entry.environmentId}:${entry.task.id}`}
              entry={entry}
              onEdit={() => setEditing(entry)}
            />
          ))}
        </ul>
      )}
      {editing !== null && (
        <ScheduledTaskEditor
          task={editing === "new" ? null : editing}
          profiles={runnable}
          initialProfileId={newForProfileId}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ScheduledTaskRow({
  entry,
  onEdit,
}: {
  entry: EnvironmentScheduledTask;
  onEdit: () => void;
}) {
  const { task, environmentId } = entry;
  const { profiles } = useAgentLibrary();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled);
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask);
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const profile = profiles.find((item) => item.profileId === task.profileId);
  const project = projects.find(
    (item) => item.environmentId === environmentId && item.id === task.projectId,
  );
  const machine =
    environments.length > 1
      ? environments.find((env) => env.environmentId === environmentId)?.label
      : undefined;
  const id = task.id;
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    await action().finally(() => setBusy(false));
  };
  // A finished one-time task has nothing to resume until it is given a new time.
  const finished = task.schedule.type === "once" && !task.enabled && task.runCount > 0;

  return (
    <li
      className="scheduled-task"
      data-enabled={task.enabled}
      style={
        profile ? ({ "--agent-color": agentColorFor(profile, profiles) } as CSSProperties) : {}
      }
    >
      <div className="scheduled-task-heading">
        {profile ? (
          <AgentIcon icon={profile.icon} iconId={profile.iconId} />
        ) : (
          <ClockIcon size={18} />
        )}
        <div className="scheduled-task-title">
          <strong>{task.title}</strong>
          <span>
            {profile?.name ?? "Agent unavailable"}
            {" · "}
            {project?.title ?? "Project unavailable"}
            {machine ? ` · ${machine}` : ""}
          </span>
        </div>
        <Switch
          size="sm"
          aria-label={task.enabled ? "Pause task" : "Resume task"}
          checked={task.enabled}
          disabled={busy || finished}
          onCheckedChange={(enabled) =>
            act(() => setEnabled({ environmentId, input: { id, enabled } }))
          }
        />
      </div>
      <p className="scheduled-task-prompt">{task.prompt}</p>
      <dl className="scheduled-task-facts">
        <div>
          <dt>Schedule</dt>
          <dd>
            {describeSchedule(task.schedule, (iso) =>
              formatUpcomingTimestamp(iso, timestampFormat),
            )}
          </dd>
        </div>
        <div>
          <dt>Next run</dt>
          <dd>
            {task.enabled && task.nextRunAt
              ? formatUpcomingTimestamp(task.nextRunAt, timestampFormat)
              : finished
                ? "Done: edit to schedule again"
                : "Paused"}
          </dd>
        </div>
        <div>
          <dt>Last run</dt>
          <dd data-status={task.lastRunStatus}>
            {task.lastRunAt
              ? `${LAST_RUN_LABELS[task.lastRunStatus]} ${formatDayAwareTimestamp(
                  task.lastRunAt,
                  timestampFormat,
                )} · ${task.runCount} ${task.runCount === 1 ? "run" : "runs"}`
              : "Never"}
          </dd>
        </div>
      </dl>
      {task.lastRunStatus === "failed" && task.lastRunError && (
        <p role="alert" className="scheduled-task-error">
          {task.lastRunError}
        </p>
      )}
      <div className="scheduled-task-actions">
        <Button
          size="compact"
          variant="outline"
          disabled={busy}
          onClick={() => act(() => runNow({ environmentId, input: { id } }))}
        >
          <PlayIcon />
          Run now
        </Button>
        {task.threadId && (
          <Button
            size="compact"
            variant="ghost"
            render={
              <Link
                to="/agents/$environmentId/$threadId"
                params={{ environmentId, threadId: task.threadId }}
              />
            }
          >
            Open thread
          </Button>
        )}
        <Button size="compact" variant="ghost" disabled={busy} onClick={onEdit}>
          <PencilIcon />
          Edit
        </Button>
        <Button
          size="compact"
          variant={confirmDelete ? "destructive-outline" : "ghost-destructive"}
          disabled={busy}
          onBlur={() => setConfirmDelete(false)}
          onClick={() =>
            confirmDelete
              ? act(() => remove({ environmentId, input: { id } }))
              : setConfirmDelete(true)
          }
        >
          <Trash2Icon />
          {confirmDelete ? "Confirm delete" : "Delete"}
        </Button>
      </div>
    </li>
  );
}
