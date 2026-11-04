import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ComposerFileAttachment, ComposerImageAttachment } from "../composerDraftStore";

export interface OfflineMessage {
  readonly environmentId: EnvironmentId;
  readonly input: StartThreadTurnInput;
  readonly attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>;
  readonly error?: string;
  readonly inheritedBootstrap?: boolean;
}

export function createOfflineOutbox(options: {
  load: () => Promise<OfflineMessage[]>;
  put: (message: OfflineMessage) => Promise<void>;
  remove: (id: string, successor?: OfflineMessage) => Promise<void>;
  canSend: (message: OfflineMessage) => boolean;
  prepare?: (message: OfflineMessage) => OfflineMessage;
  send: (message: OfflineMessage) => Promise<void>;
}) {
  let messages: ReadonlyArray<OfflineMessage> = [];
  const listeners = new Set<() => void>();
  const sending = new Set<string>();
  let mutations = Promise.resolve();
  const publish = (next: ReadonlyArray<OfflineMessage>) => {
    messages = next;
    for (const listener of listeners) listener();
  };
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutations.then(operation);
    mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const load = () => serialize(async () => publish(await options.load()));
  const enqueue = (message: OfflineMessage) =>
    serialize(async () => {
      await options.put(message);
      publish([...messages, message]);
    });
  const remove = (id: string) =>
    serialize(async () => {
      if (sending.has(id)) return;
      const index = messages.findIndex((message) => message.input.message.messageId === id);
      const removed = messages[index];
      const bootstrap = removed?.input.bootstrap;
      const next = bootstrap
        ? messages
            .slice(index + 1)
            .find(
              (message) =>
                message.environmentId === removed.environmentId &&
                message.input.threadId === removed.input.threadId,
            )
        : undefined;
      const successor =
        next && bootstrap && !next.input.bootstrap
          ? { ...next, inheritedBootstrap: true, input: { ...next.input, bootstrap } }
          : undefined;
      await options.remove(id, successor);
      publish(
        messages
          .filter((message) => message !== removed)
          .map((message) => (message === next && successor ? successor : message)),
      );
      return removed;
    });
  const retry = (id: string) =>
    serialize(async () => {
      const message = messages.find((entry) => entry.input.message.messageId === id);
      if (!message) return;
      const { error: _, ...next } = message;
      await options.put(next);
      publish(messages.map((entry) => (entry === message ? next : entry)));
    });
  const drain = async () => {
    const blockedThreads = new Set<string>();
    for (const queued of messages) {
      const id = queued.input.message.messageId;
      let message = messages.find((entry) => entry.input.message.messageId === id);
      if (!message) continue;
      const threadKey = `${message.environmentId}:${message.input.threadId}`;
      if (blockedThreads.has(threadKey)) continue;
      if (message.error || sending.has(id) || !options.canSend(message)) {
        blockedThreads.add(threadKey);
        continue;
      }
      sending.add(id);
      publish([...messages]);
      try {
        const prepared = options.prepare?.(message) ?? message;
        if (prepared !== message) {
          await serialize(async () => {
            await options.put(prepared);
            publish(
              messages.map((entry) => (entry.input.message.messageId === id ? prepared : entry)),
            );
          });
          message = prepared;
        }
        await options.send(message);
        await serialize(async () => {
          await options.remove(id);
          publish(messages.filter((entry) => entry.input.message.messageId !== id));
        });
      } catch (error) {
        blockedThreads.add(threadKey);
        if (options.canSend(message)) {
          const failed = {
            ...message,
            error: error instanceof Error ? error.message : "Could not send message.",
          };
          await serialize(async () => {
            await options.put(failed);
            publish(
              messages.map((entry) => (entry.input.message.messageId === id ? failed : entry)),
            );
          });
        }
      } finally {
        sending.delete(id);
        publish([...messages]);
      }
    }
  };
  return {
    load,
    enqueue,
    remove,
    retry,
    drain,
    isSending: (id: string) => sending.has(id),
    getSnapshot: () => messages,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
