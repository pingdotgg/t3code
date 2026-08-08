import { CommandId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { resolveThreadMetadataUpdateForNextTurn } from "./ChatView.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { useEnvironments } from "../state/environments";
import { useThreadShells } from "../state/entities";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadShells, threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import {
  beginWebThreadOutboxDispatch,
  finishWebThreadOutboxDispatch,
  shouldDrainWebThreadOutbox,
  useWebThreadOutboxStore,
} from "../webThreadOutbox";

function settingsCommandId(commandId: CommandId, setting: string): CommandId {
  return CommandId.make(`${commandId}:${setting}`);
}

export function WebThreadOutboxDrain() {
  const queuesByThreadKey = useWebThreadOutboxStore((state) => state.queuesByThreadKey);
  const pausedMessageIds = useWebThreadOutboxStore((state) => state.pausedMessageIds);
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const setThreadRuntimeMode = useAtomCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const setThreadInteractionMode = useAtomCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [drainTick, setDrainTick] = useState(0);

  const nextDelivery = useMemo(() => {
    const threadByKey = new Map(
      threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread] as const),
    );
    const environmentById = new Map(
      environments.map((environment) => [environment.environmentId, environment] as const),
    );
    const heads = Object.values(queuesByThreadKey)
      .flatMap((queue) => (queue[0] ? [queue[0]] : []))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    for (const message of heads) {
      const thread = threadByKey.get(`${message.environmentId}:${message.threadId}`);
      if (!thread) continue;
      const environment = environmentById.get(message.environmentId);
      if (
        shouldDrainWebThreadOutbox({
          sessionStatus: thread.session?.status ?? null,
          environmentConnected: environment?.connection.phase === "connected",
          paused: Boolean(pausedMessageIds[message.messageId]),
          activeTurnMessageBehavior: message.activeTurnMessageBehavior,
        })
      ) {
        return { message, thread };
      }
    }
    return null;
  }, [drainTick, environments, pausedMessageIds, queuesByThreadKey, threads]);

  useEffect(() => {
    if (!nextDelivery || !beginWebThreadOutboxDispatch(nextDelivery.message.messageId)) {
      return;
    }
    const { message, thread } = nextDelivery;

    const deliver = async () => {
      const metadataUpdate = resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: thread.modelSelection,
        nextModelSelection: message.modelSelection,
        currentBranch: thread.branch,
      });
      if (metadataUpdate) {
        const result = await updateThreadMetadata({
          environmentId: message.environmentId,
          input: {
            commandId: settingsCommandId(message.commandId, "model-selection"),
            threadId: message.threadId,
            ...metadataUpdate,
          },
        });
        if (result._tag === "Failure") return result;
      }

      if (message.runtimeMode !== thread.runtimeMode) {
        const result = await setThreadRuntimeMode({
          environmentId: message.environmentId,
          input: {
            commandId: settingsCommandId(message.commandId, "runtime-mode"),
            threadId: message.threadId,
            runtimeMode: message.runtimeMode,
            createdAt: message.createdAt,
          },
        });
        if (result._tag === "Failure") return result;
      }

      if (message.interactionMode !== thread.interactionMode) {
        const result = await setThreadInteractionMode({
          environmentId: message.environmentId,
          input: {
            commandId: settingsCommandId(message.commandId, "interaction-mode"),
            threadId: message.threadId,
            interactionMode: message.interactionMode,
            createdAt: message.createdAt,
          },
        });
        if (result._tag === "Failure") return result;
      }

      const freshThread = appAtomRegistry
        .get(environmentThreadShells.threadShellsAtom)
        .find(
          (candidate) =>
            candidate.environmentId === message.environmentId && candidate.id === message.threadId,
        );
      if (
        !freshThread ||
        !shouldDrainWebThreadOutbox({
          sessionStatus: freshThread.session?.status ?? null,
          environmentConnected: true,
          paused: Boolean(useWebThreadOutboxStore.getState().pausedMessageIds[message.messageId]),
          activeTurnMessageBehavior: message.activeTurnMessageBehavior,
        })
      ) {
        return { _tag: "Deferred" as const };
      }

      return startThreadTurn({
        environmentId: message.environmentId,
        input: {
          commandId: message.commandId,
          threadId: message.threadId,
          message: {
            messageId: message.messageId,
            role: "user",
            text: message.text,
            attachments: message.attachments,
          },
          modelSelection: message.modelSelection,
          titleSeed: thread.title,
          runtimeMode: message.runtimeMode,
          interactionMode: message.interactionMode,
          createdAt: message.createdAt,
        },
      });
    };

    void deliver()
      .then((result) => {
        if (result._tag === "Deferred") return;
        if (result._tag === "Failure") {
          useWebThreadOutboxStore.getState().pause(message.messageId);
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: "Queued delivery paused",
              description: "Open the thread and retry when the connection is ready.",
            }),
          );
          return;
        }
        useWebThreadOutboxStore.getState().remove(message);
      })
      .catch((error: unknown) => {
        console.error("[THREAD-OUTBOX] Queued delivery failed unexpectedly.", error);
        useWebThreadOutboxStore.getState().pause(message.messageId);
      })
      .finally(() => {
        finishWebThreadOutboxDispatch(message.messageId);
        setDrainTick((current) => current + 1);
      });
  }, [
    nextDelivery,
    setThreadInteractionMode,
    setThreadRuntimeMode,
    startThreadTurn,
    updateThreadMetadata,
  ]);

  return null;
}
