import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { buildPendingNewTasks, type PendingNewTask } from "./pending-new-tasks-model";
import { pendingThreadCreationOutcomesAtom, withLaunchingThreads } from "./pending-thread-creation";
import { connectedEnvironmentIdsAtom } from "./presentation";
import { flattenQueuedThreadMessages } from "./thread-outbox-model";
import { environmentThreadShells } from "./threads";
import { newTaskComposerDraftsAtom } from "./use-composer-drafts";
import { useThreadOutboxMessages } from "./use-thread-outbox";

export type {
  PendingDraftTask,
  PendingNewTask,
  PendingQueuedTask,
} from "./pending-new-tasks-model";

export function usePendingNewTasks(): ReadonlyArray<PendingNewTask> {
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const drafts = useAtomValue(newTaskComposerDraftsAtom);
  const hiddenKeys = useAtomValue(environmentThreadShells.hiddenThreadKeysAtom);
  const connectedEnvironmentIds = useAtomValue(connectedEnvironmentIdsAtom);
  // A delivered creation can stay queued after its thread is live and hidden.
  const queuedMessages = flattenQueuedThreadMessages(queuedMessagesByThreadKey).filter(
    (message) => !hiddenKeys.has(threadKey(message)),
  );
  return buildPendingNewTasks({
    queuedMessages,
    drafts,
    connectedEnvironmentIds: new Set(connectedEnvironmentIds),
  });
}

/** The list's threads, with creations a connected environment is delivering placed as working. */
export function useLaunchingThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const outcomes = useAtomValue(pendingThreadCreationOutcomesAtom);
  const hiddenThreadKeys = useAtomValue(environmentThreadShells.hiddenThreadKeysAtom);
  const connectedEnvironmentIds = useAtomValue(connectedEnvironmentIdsAtom);
  return useMemo(() => {
    const connected = new Set(connectedEnvironmentIds);
    const launches = [
      ...flattenQueuedThreadMessages(queuedMessagesByThreadKey).filter((message) =>
        connected.has(message.environmentId),
      ),
      ...Object.values(outcomes).flatMap((outcome) =>
        outcome.kind === "delivered" ? [outcome.message] : [],
      ),
    ];
    return withLaunchingThreads({ threads, launches, hiddenThreadKeys });
  }, [threads, queuedMessagesByThreadKey, outcomes, hiddenThreadKeys, connectedEnvironmentIds]);
}
