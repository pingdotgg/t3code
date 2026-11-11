import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  buildPendingNewTasks,
  isQueuedCreationSending,
  type PendingNewTask,
  type ThreadOutboxSendGate,
} from "./pending-new-tasks-model";
import { pendingThreadCreationOutcomesAtom, withLaunchingThreads } from "./pending-thread-creation";
import { flattenQueuedThreadMessages } from "./thread-outbox-model";
import { environmentThreadShells } from "./threads";
import { newTaskComposerDraftsAtom } from "./use-composer-drafts";
import {
  retryingQueuedMessageIdsAtom,
  threadOutboxShellStatusesAtom,
  useThreadOutboxMessages,
} from "./use-thread-outbox";
import { environmentSession, sessionHasScope } from "./session";
import { workspaceConnections } from "./workspace";

export type {
  PendingDraftTask,
  PendingNewTask,
  PendingQueuedTask,
} from "./pending-new-tasks-model";

const threadOutboxSendGateAtom = Atom.make((get): ThreadOutboxSendGate => {
  const connected = get(workspaceConnections.environmentsAtom).flatMap((environment) =>
    environment.connectionState === "connected" ? [environment.environmentId] : [],
  );
  return {
    connectedEnvironmentIds: new Set(connected),
    operableEnvironmentIds: new Set(
      connected.filter((environmentId) =>
        sessionHasScope(
          get(environmentSession.sessionStateAtom(environmentId)),
          AuthOrchestrationOperateScope,
        ),
      ),
    ),
    shellStatuses: get(threadOutboxShellStatusesAtom),
    retryingMessageIds: get(retryingQueuedMessageIdsAtom),
  };
}).pipe(Atom.withLabel("mobile:pending-new-tasks:send-gate"));

export function usePendingNewTasks(): ReadonlyArray<PendingNewTask> {
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const drafts = useAtomValue(newTaskComposerDraftsAtom);
  const hiddenKeys = useAtomValue(environmentThreadShells.hiddenThreadKeysAtom);
  const sendGate = useAtomValue(threadOutboxSendGateAtom);
  // A delivered creation can stay queued after its thread is live and hidden.
  const queuedMessages = flattenQueuedThreadMessages(queuedMessagesByThreadKey).filter(
    (message) => !hiddenKeys.has(threadKey(message)),
  );
  return buildPendingNewTasks({
    queuedMessages,
    drafts,
    sendGate,
  });
}

/** The list's threads, with creations the outbox is sending placed as working. */
export function useLaunchingThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const outcomes = useAtomValue(pendingThreadCreationOutcomesAtom);
  const hiddenThreadKeys = useAtomValue(environmentThreadShells.hiddenThreadKeysAtom);
  const sendGate = useAtomValue(threadOutboxSendGateAtom);
  return useMemo(() => {
    const launches = [
      ...flattenQueuedThreadMessages(queuedMessagesByThreadKey).filter((message) =>
        isQueuedCreationSending(message, sendGate),
      ),
      ...Object.values(outcomes).flatMap((outcome) =>
        outcome.kind === "delivered" ? [outcome.message] : [],
      ),
    ];
    return withLaunchingThreads({ threads, launches, hiddenThreadKeys });
  }, [threads, queuedMessagesByThreadKey, outcomes, hiddenThreadKeys, sendGate]);
}
