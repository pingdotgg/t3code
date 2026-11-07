import { threadWorkIsActive } from "@t3tools/client-runtime/state/shell";
import {
  ACTIVE_RUN_COMMIT_COPY,
  QUEUED_COMMIT_DROPPED_COPY,
  requiresActiveRunConfirmation,
} from "@t3tools/client-runtime/state/vcs";
import type { GitStackedAction, ScopedThreadRef } from "@t3tools/contracts";

import * as Dialog from "../../../components/ui/Dialog";
import { appAtomRegistry } from "../../../state/atom-registry";
import { environmentThreadShells } from "../../../state/threads";
import { gitActionQueue } from "../../../state/vcs";

export function confirmCommitDuringRun(input: {
  readonly thread: ScopedThreadRef | null;
  readonly action: GitStackedAction;
  readonly queuedRun: (() => void) | null;
}): Promise<"proceed" | "queued" | "cancelled"> {
  const { thread, queuedRun } = input;
  // A native menu keeps the closure from when it opened, and a run can start while it is open.
  const shell =
    thread === null ? null : appAtomRegistry.get(environmentThreadShells.threadShellAtom(thread));
  if (!requiresActiveRunConfirmation(input.action, threadWorkIsActive(shell))) {
    return Promise.resolve("proceed");
  }
  const canQueue =
    thread !== null &&
    queuedRun !== null &&
    appAtomRegistry.get(gitActionQueue.queuedActionAtom(thread)) === null;
  return new Promise((resolve) => {
    Dialog.alert(ACTIVE_RUN_COMMIT_COPY.title, ACTIVE_RUN_COMMIT_COPY.description, [
      ...(canQueue
        ? [
            {
              text: ACTIVE_RUN_COMMIT_COPY.queueLabel,
              onPress: () => {
                gitActionQueue.enqueue(thread, {
                  action: input.action,
                  run: queuedRun,
                  onDropped: () =>
                    Dialog.alert(
                      QUEUED_COMMIT_DROPPED_COPY.title,
                      QUEUED_COMMIT_DROPPED_COPY.description,
                    ),
                });
                resolve("queued");
              },
            },
          ]
        : []),
      { text: ACTIVE_RUN_COMMIT_COPY.continueLabel, onPress: () => resolve("proceed") },
      { text: "Cancel", style: "cancel", onPress: () => resolve("cancelled") },
    ]);
  });
}
