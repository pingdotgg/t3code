import type { MessageId } from "@t3tools/contracts";

import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  type QueuedThreadMessage,
} from "./thread-outbox-model";

const THREAD_OUTBOX_DIRECTORY = "thread-outbox";

export interface ThreadOutboxStorage {
  readonly load: () => Promise<ReadonlyArray<QueuedThreadMessage>>;
  readonly write: (message: QueuedThreadMessage) => Promise<void>;
  readonly remove: (message: QueuedThreadMessage) => Promise<void>;
}

function messageFileName(messageId: MessageId): string {
  return `${encodeURIComponent(messageId)}.json`;
}

async function getOutboxDirectory() {
  const { Directory, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, THREAD_OUTBOX_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

async function getMessageFile(messageId: MessageId) {
  const { File } = await import("expo-file-system");
  return new File(await getOutboxDirectory(), messageFileName(messageId));
}

export const expoThreadOutboxStorage: ThreadOutboxStorage = {
  load: async () => {
    const { File } = await import("expo-file-system");
    const directory = await getOutboxDirectory();
    const messages: QueuedThreadMessage[] = [];

    for (const entry of directory.list()) {
      if (!(entry instanceof File) || !entry.name.endsWith(".json")) {
        continue;
      }
      try {
        messages.push(decodeQueuedThreadMessage(JSON.parse(await entry.text()) as unknown));
      } catch (error) {
        console.warn("[thread-outbox] ignored invalid persisted message", entry.name, error);
      }
    }
    return messages;
  },
  write: async (message) => {
    const file = await getMessageFile(message.messageId);
    if (!file.exists) {
      file.create({ intermediates: true, overwrite: true });
    }
    file.write(JSON.stringify(encodeQueuedThreadMessage(message)));
  },
  remove: async (message) => {
    const file = await getMessageFile(message.messageId);
    if (file.exists) {
      file.delete();
    }
  },
};
