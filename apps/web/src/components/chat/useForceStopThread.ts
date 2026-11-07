import { useT } from "../../hooks/useI18n";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

/** Force stop for an agent that no longer answers Stop; shared by every place that offers it. */
export function useForceStopThread(environmentId: EnvironmentId) {
  const t = useT();
  const forceStop = useAtomCommand(orchestrationEnvironment.forceStopThread);
  const permitted = useAtomValue(
    orchestrationEnvironment.forceStopThread.permissionAtom(environmentId),
  );
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.threadForceStop === true;
  const canForceStop = permitted && supported;
  const [stoppingThreadId, setStoppingThreadId] = useState<ThreadId | null>(null);
  /** Pass the run that ignored Stop, so a Force stop left open cannot hit a newer run. */
  const forceStopThread = async (threadId: ThreadId, runId?: RunId) => {
    if (!canForceStop || stoppingThreadId !== null) return;
    setStoppingThreadId(threadId);
    const result = await forceStop({
      environmentId,
      input: runId === undefined ? { threadId } : { threadId, runId },
    });
    setStoppingThreadId(null);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: t("chat.sys.forceStopFailed"),
        description: error instanceof Error ? error.message : undefined,
      });
      return;
    }
    const others = result.value.sharedWithThreadIds.length;
    if (result.value.outcome === "releasing") {
      toastManager.add({
        type: "info",
        title: t("chat.sys.turnStoppedShuttingDown"),
      });
    }
    if (result.value.outcome === "shared") {
      toastManager.add({
        type: "info",
        title: t("chat.sys.turnStoppedShared"),
        description:
          others === 0
            ? t("chat.sys.sharedWithOther", { noun: t("chat.sys.threadMany") })
            : t("chat.sys.sharedWithCount", {
                count: others,
                noun: others === 1 ? t("chat.sys.threadOne") : t("chat.sys.threadMany"),
              }),
      });
    }
  };
  return { canForceStop, stoppingThreadId, forceStopThread };
}
