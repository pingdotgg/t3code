import { useAtomValue } from "@effect/atom-react";
import type { MessageId } from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";

import { randomHex } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { useProjects, useThreadShells } from "./entities";
import { ensureThreadOutboxLoaded, removeThreadOutboxMessage } from "./thread-outbox";
import { createThreadOutboxDrainWorker } from "./thread-outbox-drain-worker";
import { startThreadOutboxLoadRetry } from "./thread-outbox-load-retry";
import { threadOutboxRetryDelayMs } from "./thread-outbox-model";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";
import {
  editingQueuedMessageIdsAtom,
  useThreadOutboxMessages,
  useThreadOutboxShellStatuses,
} from "./use-thread-outbox";
import { useRemoteConnectionStatus } from "./use-remote-environment-registry";

export const dispatchingQueuedMessageIdAtom = Atom.make<MessageId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-outbox:dispatching-message-id"),
);

function beginDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, queuedMessageId);
}

function finishDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  const current = appAtomRegistry.get(dispatchingQueuedMessageIdAtom);
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, current === queuedMessageId ? null : current);
}

export function useThreadOutboxDrain(): void {
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);
  const editingQueuedMessageIds = useAtomValue(editingQueuedMessageIdsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const shellStatuses = useThreadOutboxShellStatuses();
  const threads = useThreadShells();
  const projects = useProjects();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const [retryTick, setRetryTick] = useState(0);
  const retryAttemptRef = useRef(new Map<MessageId, number>());
  const retryNotBeforeRef = useRef(new Map<MessageId, number>());
  const retryTimersRef = useRef(new Map<MessageId, ReturnType<typeof setTimeout>>());
  const connectedEnvironmentKey = connectedEnvironments
    .filter((environment) => environment.connectionState === "connected")
    .map((environment) => environment.environmentId)
    .sort()
    .join("\n");
  const worker = useMemo(
    () =>
      createThreadOutboxDrainWorker({
        remove: removeThreadOutboxMessage,
        startTurn,
        updateThreadMetadata,
        setThreadRuntimeMode,
        setThreadInteractionMode,
        makeWorktreeBranchName: () => buildTemporaryWorktreeBranchName(randomHex),
      }),
    [setThreadInteractionMode, setThreadRuntimeMode, startTurn, updateThreadMetadata],
  );

  useEffect(() => {
    return startThreadOutboxLoadRetry({
      load: ensureThreadOutboxLoaded,
      retryDelayMs: threadOutboxRetryDelayMs,
    });
  }, [connectedEnvironmentKey]);

  useEffect(() => {
    return () => {
      for (const timer of retryTimersRef.current.values()) {
        clearTimeout(timer);
      }
      retryTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (dispatchingQueuedMessageId !== null) {
      return;
    }

    let attemptedMessageId: MessageId | null = null;
    void worker
      .drainNext({
        queuedMessagesByThreadKey,
        editingQueuedMessageIds,
        shellStatuses,
        connectedEnvironmentIds: new Set(
          connectedEnvironments
            .filter((environment) => environment.connectionState === "connected")
            .map((environment) => environment.environmentId),
        ),
        threads,
        projects,
        canDispatch: (message) =>
          (retryNotBeforeRef.current.get(message.messageId) ?? 0) <= Date.now(),
        onAttemptStart: (message) => {
          attemptedMessageId = message.messageId;
          beginDispatchingQueuedMessage(message.messageId);
        },
      })
      .then((result) => {
        if (result._tag === "Idle") {
          return;
        }
        if (result.delivered) {
          retryAttemptRef.current.delete(result.messageId);
          retryNotBeforeRef.current.delete(result.messageId);
          const pendingTimer = retryTimersRef.current.get(result.messageId);
          if (pendingTimer !== undefined) {
            clearTimeout(pendingTimer);
            retryTimersRef.current.delete(result.messageId);
          }
          return;
        }

        const retryAttempt = (retryAttemptRef.current.get(result.messageId) ?? 0) + 1;
        retryAttemptRef.current.set(result.messageId, retryAttempt);
        const retryDelayMs = threadOutboxRetryDelayMs(retryAttempt);
        retryNotBeforeRef.current.set(result.messageId, Date.now() + retryDelayMs);
        const pendingTimer = retryTimersRef.current.get(result.messageId);
        if (pendingTimer !== undefined) {
          clearTimeout(pendingTimer);
        }
        const retryTimer = setTimeout(() => {
          retryTimersRef.current.delete(result.messageId);
          setRetryTick((current) => current + 1);
        }, retryDelayMs);
        retryTimersRef.current.set(result.messageId, retryTimer);
      })
      .finally(() => {
        if (attemptedMessageId !== null) {
          finishDispatchingQueuedMessage(attemptedMessageId);
        }
      });
  }, [
    connectedEnvironments,
    dispatchingQueuedMessageId,
    editingQueuedMessageIds,
    projects,
    queuedMessagesByThreadKey,
    retryTick,
    shellStatuses,
    threads,
    worker,
  ]);
}
