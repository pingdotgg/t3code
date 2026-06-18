import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { type MessageId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";

import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import { useThreadShells } from "./entities";
import { ensureThreadOutboxLoaded, removeThreadOutboxMessage } from "./thread-outbox";
import {
  resolveThreadOutboxDeliveryAction,
  shouldRetryThreadOutboxDelivery,
  threadOutboxRetryDelayMs,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";
import { useThreadOutboxMessages, useThreadOutboxShellStatuses } from "./use-thread-outbox";
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

function findThread(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  message: QueuedThreadMessage,
): EnvironmentThreadShell | undefined {
  return threads.find(
    (candidate) =>
      candidate.environmentId === message.environmentId && candidate.id === message.threadId,
  );
}

export function useThreadOutboxDrain(): void {
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const shellStatuses = useThreadOutboxShellStatuses();
  const threads = useThreadShells();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const [retryTick, setRetryTick] = useState(0);
  const retryAttemptRef = useRef(new Map<MessageId, number>());
  const retryNotBeforeRef = useRef(new Map<MessageId, number>());
  const retryTimersRef = useRef(new Map<MessageId, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    ensureThreadOutboxLoaded();
    return () => {
      for (const timer of retryTimersRef.current.values()) {
        clearTimeout(timer);
      }
      retryTimersRef.current.clear();
    };
  }, []);

  const sendQueuedMessage = useCallback(
    async (queuedMessage: QueuedThreadMessage, thread: EnvironmentThreadShell) => {
      const deliveryResult = await startTurn({
        environmentId: queuedMessage.environmentId,
        input: {
          commandId: queuedMessage.commandId,
          threadId: queuedMessage.threadId,
          message: {
            messageId: queuedMessage.messageId,
            role: "user",
            text: queuedMessage.text,
            attachments: queuedMessage.attachments,
          },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: queuedMessage.createdAt,
        },
      });
      if (AsyncResult.isFailure(deliveryResult)) {
        const error = Cause.squash(deliveryResult.cause);
        const retry =
          Cause.hasInterruptsOnly(deliveryResult.cause) || shouldRetryThreadOutboxDelivery(error);
        console.warn("[thread-outbox] queued message delivery failed", {
          environmentId: queuedMessage.environmentId,
          threadId: queuedMessage.threadId,
          messageId: queuedMessage.messageId,
          cause: deliveryResult.cause,
          retry,
        });
        if (retry) {
          return false;
        }
      }

      try {
        await removeThreadOutboxMessage(queuedMessage);
        return true;
      } catch (error) {
        console.warn("[thread-outbox] failed to remove delivered queued message", {
          environmentId: queuedMessage.environmentId,
          threadId: queuedMessage.threadId,
          messageId: queuedMessage.messageId,
          error,
        });
        return false;
      }
    },
    [startTurn],
  );

  useEffect(() => {
    if (dispatchingQueuedMessageId !== null) {
      return;
    }

    for (const [threadKey, queuedMessages] of Object.entries(queuedMessagesByThreadKey)) {
      const nextQueuedMessage = queuedMessages[0];
      if (!nextQueuedMessage) {
        continue;
      }
      if ((retryNotBeforeRef.current.get(nextQueuedMessage.messageId) ?? 0) > Date.now()) {
        continue;
      }

      const thread = findThread(threads, nextQueuedMessage);
      if (thread && scopedThreadKey(thread.environmentId, thread.id) !== threadKey) {
        continue;
      }

      const environment = connectedEnvironments.find(
        (candidate) => candidate.environmentId === nextQueuedMessage.environmentId,
      );
      const deliveryAction = resolveThreadOutboxDeliveryAction({
        threadExists: thread !== undefined,
        shellStatus: shellStatuses.get(nextQueuedMessage.environmentId) ?? "empty",
        environmentConnected: environment?.connectionState === "connected",
        threadBusy: thread?.session?.status === "running" || thread?.session?.status === "starting",
      });
      if (deliveryAction === "wait") {
        continue;
      }

      beginDispatchingQueuedMessage(nextQueuedMessage.messageId);
      const delivery =
        deliveryAction === "remove"
          ? removeThreadOutboxMessage(nextQueuedMessage).then(
              () => true,
              (error) => {
                console.warn("[thread-outbox] failed to remove message for a missing thread", {
                  environmentId: nextQueuedMessage.environmentId,
                  threadId: nextQueuedMessage.threadId,
                  messageId: nextQueuedMessage.messageId,
                  error,
                });
                return false;
              },
            )
          : thread !== undefined
            ? sendQueuedMessage(nextQueuedMessage, thread)
            : Promise.resolve(false);
      void delivery
        .then((sent) => {
          if (sent) {
            retryAttemptRef.current.delete(nextQueuedMessage.messageId);
            retryNotBeforeRef.current.delete(nextQueuedMessage.messageId);
            const pendingTimer = retryTimersRef.current.get(nextQueuedMessage.messageId);
            if (pendingTimer !== undefined) {
              clearTimeout(pendingTimer);
              retryTimersRef.current.delete(nextQueuedMessage.messageId);
            }
            return;
          }

          const retryAttempt = (retryAttemptRef.current.get(nextQueuedMessage.messageId) ?? 0) + 1;
          retryAttemptRef.current.set(nextQueuedMessage.messageId, retryAttempt);
          const retryDelayMs = threadOutboxRetryDelayMs(retryAttempt);
          retryNotBeforeRef.current.set(nextQueuedMessage.messageId, Date.now() + retryDelayMs);
          const pendingTimer = retryTimersRef.current.get(nextQueuedMessage.messageId);
          if (pendingTimer !== undefined) {
            clearTimeout(pendingTimer);
          }
          const retryTimer = setTimeout(() => {
            retryTimersRef.current.delete(nextQueuedMessage.messageId);
            setRetryTick((current) => current + 1);
          }, retryDelayMs);
          retryTimersRef.current.set(nextQueuedMessage.messageId, retryTimer);
        })
        .finally(() => {
          finishDispatchingQueuedMessage(nextQueuedMessage.messageId);
        });
      return;
    }
  }, [
    connectedEnvironments,
    dispatchingQueuedMessageId,
    queuedMessagesByThreadKey,
    retryTick,
    sendQueuedMessage,
    shellStatuses,
    threads,
  ]);
}
