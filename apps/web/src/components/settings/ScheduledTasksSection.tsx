import { type EnvironmentId, type ProjectId, type OrchestrationTask } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useState } from "react";

import { orchestrationEnvironment, taskCommands } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { readEnvironmentSupportsTaskScheduling } from "../../state/entities";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type SchedulePreset = "in-1h" | "tomorrow-9" | "daily-9" | "weekly-mon-9";

const PRESET_LABELS: Record<SchedulePreset, string> = {
  "in-1h": "Once, in 1 hour",
  "tomorrow-9": "Once, tomorrow at 9:00",
  "daily-9": "Every day at 9:00",
  "weekly-mon-9": "Every Monday at 9:00",
};

function nextNineAm(fromMs: number): string {
  const nineAm = new Date(fromMs + DAY_MS);
  nineAm.setHours(9, 0, 0, 0);
  return nineAm.toISOString();
}

function resolveSchedule(preset: SchedulePreset): OrchestrationTask["schedule"] {
  const now = Date.now();
  switch (preset) {
    case "in-1h":
      return { kind: "once", at: new Date(now + HOUR_MS).toISOString() };
    case "tomorrow-9":
      return { kind: "once", at: nextNineAm(now) };
    case "daily-9":
      return { kind: "interval", everyMs: DAY_MS };
    case "weekly-mon-9":
      return { kind: "interval", everyMs: 7 * DAY_MS };
  }
}

function describeSchedule(schedule: OrchestrationTask["schedule"]): string {
  if (schedule.kind === "once") {
    return `Once · ${new Date(schedule.at).toLocaleString()}`;
  }
  if (schedule.everyMs === DAY_MS) return "Every day";
  if (schedule.everyMs === 7 * DAY_MS) return "Every week";
  return `Every ${Math.round(schedule.everyMs / HOUR_MS)}h`;
}

function formatWhen(iso: string | null): string {
  if (iso === null) return "—";
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return "due";
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function makeTaskId(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ScheduledTasksSection({
  environmentId,
  projectId,
  threads,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const supported = readEnvironmentSupportsTaskScheduling(environmentId);

  const [threadKey, setThreadKey] = useState<string>(
    () => `${environmentId}:${threads[0]?.id ?? ""}`,
  );
  const [preset, setPreset] = useState<SchedulePreset>("tomorrow-9");
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const tasksResult = useAtomValue(
    orchestrationEnvironment.scheduledTasks({ environmentId, input: { projectId } }),
  );
  const tasksValue = Option.getOrNull(AsyncResult.value(tasksResult));
  const schedule = useAtomCommand(taskCommands.scheduleTask, { reportFailure: false });
  const cancel = useAtomCommand(taskCommands.cancelTask, { reportFailure: false });

  if (!supported) {
    return null;
  }

  const tasks = [...(tasksValue?.tasks ?? [])].toSorted((a, b) => {
    if ((a.cancelledAt !== null) !== (b.cancelledAt !== null)) {
      return a.cancelledAt === null ? -1 : 1;
    }
    return (a.nextFireAt ?? "").localeCompare(b.nextFireAt ?? "");
  });

  const selectedThreadId = threadKey.startsWith(`${environmentId}:`)
    ? threadKey.slice(environmentId.length + 1)
    : "";
  const anchorThread = threads.find((thread) => thread.id === selectedThreadId);

  const submit = async () => {
    const trimmedPrompt = prompt.trim();
    if (!anchorThread || trimmedPrompt.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      const result = await schedule({
        environmentId,
        input: {
          taskId: makeTaskId(),
          projectId,
          threadId: anchorThread.id,
          prompt: trimmedPrompt,
          schedule: resolveSchedule(preset),
        },
      });
      if (result._tag === "Success") {
        setPrompt("");
        toastManager.add({ type: "success", title: "Task scheduled" });
      } else {
        toastManager.add({ type: "error", title: "Could not schedule task" });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const cancelTaskById = async (taskId: string) => {
    const result = await cancel({ environmentId, input: { taskId } });
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not cancel task" });
    }
  };

  return (
    <SettingsSection title="Scheduled tasks">
      <p className="text-sm text-muted-foreground">
        Start a turn on a thread automatically — nightly checkups, follow-ups, recurring chores.
        Runs only while this T3 server is up.
      </p>
      {threads.length > 0 ? (
        <>
          <SettingsRow
            title="Run on"
            description="The thread each scheduled run appends to."
            control={
              <Select value={threadKey} onValueChange={(value) => setThreadKey(String(value))}>
                <SelectTrigger className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {threads.map((thread) => (
                    <SelectItem key={thread.id} value={`${environmentId}:${thread.id}`}>
                      {thread.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            title="Schedule"
            description="When the run fires."
            control={
              <Select
                value={preset}
                onValueChange={(value) => setPreset(String(value) as SchedulePreset)}
              >
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {(Object.keys(PRESET_LABELS) as SchedulePreset[]).map((key) => (
                    <SelectItem key={key} value={key}>
                      {PRESET_LABELS[key]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            title="Prompt"
            description="Sent as the user message for each run."
            control={
              <div className="flex w-full max-w-xl items-center gap-2">
                <Input
                  value={prompt}
                  placeholder="e.g. Run the test suite and report failures"
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void submit();
                  }}
                />
                <Button
                  size="sm"
                  onClick={() => void submit()}
                  disabled={submitting || prompt.trim().length === 0}
                >
                  Schedule
                </Button>
              </div>
            }
          />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Create a thread first — scheduled runs append to an existing thread.
        </p>
      )}
      {tasks.length > 0 ? (
        <ul className="mt-2 flex flex-col divide-y">
          {tasks.map((task) => (
            <li key={task.taskId} className="flex items-center justify-between gap-4 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm">{task.prompt}</p>
                <p className="text-xs text-muted-foreground">
                  {describeSchedule(task.schedule)}
                  {task.cancelledAt === null && task.nextFireAt !== null
                    ? ` · next ${formatWhen(task.nextFireAt)}`
                    : ""}
                  {task.lastFiredAt !== null
                    ? ` · last ran ${new Date(task.lastFiredAt).toLocaleString()}`
                    : ""}
                  {task.cancelledAt !== null ? " · cancelled" : ""}
                </p>
              </div>
              {task.cancelledAt === null ? (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => void cancelTaskById(task.taskId)}
                >
                  Cancel
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </SettingsSection>
  );
}
