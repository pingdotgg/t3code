import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScheduledTask,
  type ScheduledTaskId,
} from "@t3tools/contracts";
import { useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  displayedScheduledTaskEnabled,
  type RequestedScheduledTaskEnabled,
} from "./scheduledTaskPresentation";

export type ScheduledTaskAction = "run" | "toggle" | "delete";

const FAILURE_TITLES = {
  run: "Could not run task",
  toggle: "Could not update task",
  delete: "Could not delete task",
} as const satisfies Record<ScheduledTaskAction, string>;

/** Run, pause or resume, and delete for one environment's tasks, one action at a time. */
export function useScheduledTaskActions(environmentId: EnvironmentId) {
  const permitted = useAtomValue(
    serverEnvironment.runScheduledTaskNow.permissionAtom(environmentId),
  );
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "scheduled task enabled",
    reportFailure: false,
  });
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run",
    reportFailure: false,
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "scheduled task delete",
    reportFailure: false,
  });
  const [busyTaskId, setBusyTaskId] = useState<ScheduledTaskId | null>(null);
  const [requested, setRequested] = useState<
    ReadonlyMap<ScheduledTaskId, RequestedScheduledTaskEnabled>
  >(() => new Map());

  const isEnabled = (task: ScheduledTask) =>
    displayedScheduledTaskEnabled(task, requested.get(task.id) ?? null);
  const act = async (task: ScheduledTask, action: ScheduledTaskAction) => {
    if (busyTaskId !== null || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
      return;
    setBusyTaskId(task.id);
    const enabled = !isEnabled(task);
    if (action === "toggle")
      setRequested((current) =>
        new Map(current).set(task.id, { taskId: task.id, enabled, since: task.updatedAt }),
      );
    const result =
      action === "run"
        ? await runNow({ environmentId, input: { id: task.id } })
        : action === "toggle"
          ? await setEnabled({ environmentId, input: { id: task.id, enabled } })
          : await remove({ environmentId, input: { id: task.id } });
    setBusyTaskId(null);
    if (result._tag === "Failure" && action === "toggle")
      setRequested((current) => {
        const next = new Map(current);
        next.delete(task.id);
        return next;
      });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(FAILURE_TITLES[action], error instanceof Error ? error.message : "Try again.");
    }
  };
  return { canOperate: permitted && busyTaskId === null, isEnabled, act };
}
