import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

const STOP_RETRY_AFTER_MS = 10_000;

/** Older servers answer neither per-task stop nor task output, so both stay hidden there. */
export function useBackgroundTaskControl(environmentId: EnvironmentId): boolean {
  return (
    useServerConfigs().get(environmentId)?.environment.capabilities.backgroundTaskControl === true
  );
}

/** Stops one background task. A stopped task leaves the roster, which unmounts its row. */
export function useBackgroundTaskStop(environmentId: EnvironmentId, threadId: ThreadId) {
  const supported = useBackgroundTaskControl(environmentId);
  const permitted = useAtomValue(
    orchestrationEnvironment.stopBackgroundTask.permissionAtom(environmentId),
  );
  const stopTask = useAtomCommand(orchestrationEnvironment.stopBackgroundTask, {
    label: "background task stop",
  });
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());

  const stop = async (taskId: string) => {
    if (stopping.has(taskId)) return;
    setStopping((current) => new Set(current).add(taskId));
    const result = await stopTask({ environmentId, input: { threadId, taskId } });
    const release = () =>
      setStopping((current) => {
        const next = new Set(current);
        next.delete(taskId);
        return next;
      });
    if (result._tag === "Success") {
      // The row normally leaves first; if the provider never reports the stop, allow a retry.
      window.setTimeout(release, STOP_RETRY_AFTER_MS);
      return;
    }
    release();
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not stop background task",
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  return { available: supported && permitted, stopping, stop };
}
