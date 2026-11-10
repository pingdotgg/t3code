import { useAtomValue } from "@effect/atom-react";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { buildPendingNewTasks, type PendingNewTask } from "./pending-new-tasks-model";
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
