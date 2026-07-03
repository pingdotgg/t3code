import { useMemo } from "react";

import { deriveThreadTitleFromPrompt } from "../lib/projectThreadStartTurn";
import {
  flattenQueuedThreadMessages,
  type QueuedThreadCreation,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import { useThreadOutboxMessages } from "./use-thread-outbox";

/** A queued new-task creation, shaped for thread-list presentation. */
export interface PendingNewTask {
  readonly message: QueuedThreadMessage;
  readonly creation: QueuedThreadCreation;
  readonly title: string;
}

export function usePendingNewTasks(): ReadonlyArray<PendingNewTask> {
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  return useMemo(() => {
    const tasks: PendingNewTask[] = [];
    for (const message of flattenQueuedThreadMessages(queuedMessagesByThreadKey)) {
      if (!message.creation) {
        continue;
      }
      tasks.push({
        message,
        creation: message.creation,
        title: deriveThreadTitleFromPrompt(message.text),
      });
    }
    tasks.sort((left, right) => right.message.createdAt.localeCompare(left.message.createdAt));
    return tasks;
  }, [queuedMessagesByThreadKey]);
}
