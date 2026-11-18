import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useGT } from "gt-react";

import { toastManager } from "../components/ui/toast";
import { m } from "../i18n/messages";
import { serverEnvironment } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import type { Thread } from "../types";

/** Stops the thread's agent session so the next message starts fresh, with providers reloaded. */
export function useRestartAgentSession() {
  const gt = useGT();
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, {
    reportFailure: false,
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const restart = async (
    thread: Pick<Thread, "environmentId" | "id" | "runtime" | "modelSelection" | "worktreePath">,
    workspaceRoot: string | null,
  ) => {
    const { environmentId } = thread;
    if (thread.runtime !== null) {
      const stopped = await stopThreadSession({ environmentId, input: { threadId: thread.id } });
      if (stopped._tag === "Failure") throw squashAtomCommandFailure(stopped);
    }
    toastManager.add({
      type: "success",
      title: gt("Agent session will restart"),
      description: gt("Your next message starts a fresh session."),
    });
    if (workspaceRoot === null) return;
    const refreshed = await refreshProviders({
      environmentId,
      input: {
        instanceId: thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId,
        cwd: thread.worktreePath ?? workspaceRoot,
        fresh: true,
      },
    });
    if (refreshed._tag === "Failure") throw squashAtomCommandFailure(refreshed);
  };
  return (...args: Parameters<typeof restart>) =>
    restart(...args).catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: gt("Unable to restart agent session"),
        description: thrownErrorMessage(error, m) ?? gt("An unexpected error occurred."),
      });
    });
}
