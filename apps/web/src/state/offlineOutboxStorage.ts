import * as Schema from "effect/Schema";
import {
  ChatImageAttachment,
  ChatFileAttachment,
  EnvironmentId,
  ThreadId,
  MessageId,
  RuntimeMode,
  ProviderInteractionMode,
} from "@t3tools/contracts";
import type { OfflineMessage } from "./offlineOutbox";

let database: Promise<IDBDatabase> | undefined;
function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("t3code:offline-outbox", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("messages");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
  }));
}
async function transact<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const transaction = (await openDatabase()).transaction("messages", mode);
  const request = operation(transaction.objectStore("messages"));
  return new Promise<T>((resolve, reject) => {
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Could not save offline messages."));
    transaction.onerror = () => reject(transaction.error);
  });
}
const storedMessage = Schema.Struct({
  environmentId: EnvironmentId,
  input: Schema.Struct({
    threadId: ThreadId,
    createdAt: Schema.optional(Schema.String),
    message: Schema.Struct({
      messageId: MessageId,
      role: Schema.Literal("user"),
      text: Schema.String,
      attachments: Schema.Array(Schema.Unknown),
    }),
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
  }),
  attachments: Schema.Array(
    Schema.Union([
      ChatImageAttachment.mapFields((fields) => ({
        ...fields,
        previewUrl: Schema.String,
        file: Schema.instanceOf(File),
      })),
      ChatFileAttachment.mapFields((fields) => ({
        ...fields,
        file: Schema.NullOr(Schema.instanceOf(File)),
      })),
    ]),
  ),
  error: Schema.optional(Schema.String),
  inheritedBootstrap: Schema.optional(Schema.Boolean),
  modeChanges: Schema.optional(
    Schema.Struct({ runtime: Schema.Boolean, interaction: Schema.Boolean }),
  ),
});
const isOfflineMessage = (value: unknown): value is OfflineMessage =>
  Schema.is(storedMessage)(value);

export const offlineOutboxStorage = {
  load: async (): Promise<OfflineMessage[]> => {
    const messages: unknown[] = await transact("readonly", (store) => store.getAll());
    return messages
      .filter(isOfflineMessage)
      .sort((a, b) => (a.input.createdAt ?? "").localeCompare(b.input.createdAt ?? ""));
  },
  put: async (message: OfflineMessage) => {
    await transact("readwrite", (store) => store.put(message, message.input.message.messageId));
  },
  remove: async (id: string, successor?: OfflineMessage) => {
    await transact("readwrite", (store) => {
      if (successor) store.put(successor, successor.input.message.messageId);
      return store.delete(id);
    });
  },
};
