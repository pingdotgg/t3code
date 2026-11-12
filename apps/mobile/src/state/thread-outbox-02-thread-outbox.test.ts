import { describe, expect, it } from "@effect/vitest";
import { EnvironmentNotRegisteredError } from "@t3tools/client-runtime/connection";
import { isTransportConnectionErrorMessage } from "@t3tools/client-runtime/errors";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import {
  CommandId,
  ComposerContextId,
  EnvironmentAuthorizationError,
  EnvironmentId,
  MessageId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import * as RpcClientError from "effect/rpc/RpcClientError";
import * as Socket from "effect/socket/Socket";
import { onTestFinished, vi } from "vite-plus/test";

const outboxFiles = vi.hoisted(() => new Map<string, string | Error>());

vi.mock("expo-file-system", () => {
  class Directory {
    create() {}

    list() {
      return Array.from(outboxFiles.keys(), (name) => new File(name));
    }
  }

  class File {
    readonly name: string;
    readonly parentDirectory = new Directory();

    constructor(...parts: [string] | [Directory, string]) {
      this.name = parts.length === 1 ? parts[0] : parts[1];
    }

    get exists() {
      return outboxFiles.has(this.name);
    }

    create() {
      outboxFiles.set(this.name, "");
    }

    write(contents: string) {
      outboxFiles.set(this.name, contents);
    }

    moveSync(file: File) {
      const contents = outboxFiles.get(this.name);
      if (contents === undefined) throw new Error("Missing file");
      outboxFiles.set(file.name, contents);
      outboxFiles.delete(this.name);
    }

    delete() {
      outboxFiles.delete(this.name);
    }

    async text(): Promise<string> {
      const contents = outboxFiles.get(this.name);
      if (contents instanceof Error) throw contents;
      if (contents === undefined) throw new Error("Missing file");
      return contents;
    }
  }

  return {
    File,
    Directory,
    Paths: { document: "/documents" },
  };
});

import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  isQueuedThreadCreationSendable,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxDispatchStep,
  resolveThreadOutboxFailureAction,
  resolveQueuedThreadSettings,
  shouldRetryThreadOutboxDelivery,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import { createThreadOutboxManager, ThreadOutboxManagerError } from "./thread-outbox-manager";
import {
  expoThreadOutboxStorage,
  ThreadOutboxStorageError,
  type ThreadOutboxLoadResult,
  type ThreadOutboxStorage,
} from "./thread-outbox-storage";

function queuedMessage(input: {
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly messageId: string;
  readonly createdAt: string;
}): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make(input.environmentId ?? "environment-1"),
    threadId: ThreadId.make(input.threadId ?? "thread-1"),
    messageId: MessageId.make(input.messageId),
    commandId: CommandId.make(`command-${input.messageId}`),
    text: input.messageId,
    attachments: [],
    createdAt: input.createdAt,
  };
}



describe("thread outbox", () => {
  it("updates a queued message in place but never resurrects a removed one", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const storage: ThreadOutboxStorage = {
      load: async () => ({ messages: [...stored.values()], errors: [] }),
      write: async (message) => {
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        stored.delete(message.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    await manager.enqueue(message);
    const edited = { ...message, text: "edited" };
    await expect(manager.update(edited)).resolves.toBe(true);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [edited],
    });
    expect(stored.get(message.messageId)).toEqual(edited);

    await manager.remove(edited);
    await expect(manager.update({ ...message, text: "stale flush" })).resolves.toBe(false);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    expect(stored.size).toBe(0);
    registry.dispose();
  });
  it("rejects a stale revision before its payload reaches durable storage", async () => {
    const registry = AtomRegistry.make();
    const writes: string[] = [];
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => ({ messages: [], errors: [] }),
        write: async (message) => {
          writes.push(message.text);
        },
        remove: async () => undefined,
      },
    });
    const original = queuedMessage({
      messageId: "message-edit-race",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const edited = { ...original, text: "keep my changes" };

    await manager.enqueue(original);
    const revision = manager.revisionOf(original.messageId);
    await manager.update(edited);

    await expect(manager.update({ ...original, text: "stale upload" }, revision)).resolves.toBe(
      false,
    );
    expect(writes).toEqual([original.text, "keep my changes"]);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [edited],
    });
    registry.dispose();
  });
  it("does not publish a stale attachment update after a replacement appears during its write", async () => {
    const registry = AtomRegistry.make();
    const writes: string[] = [];
    let resumeWrite: () => void = () => {};
    let signalWriteStarted: () => void = () => {};
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    const writeBarrier = new Promise<void>((resolve) => {
      resumeWrite = resolve;
    });
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => ({ messages: [], errors: [] }),
        write: async (message) => {
          writes.push(message.text);
          if (message.text === "stale upload") {
            signalWriteStarted();
            await writeBarrier;
          }
        },
        remove: async () => undefined,
      },
    });
    const original = queuedMessage({
      messageId: "message-write-race",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const replacement = { ...original, text: "newer edit" };

    await manager.enqueue(original);
    const update = manager.update(
      { ...original, text: "stale upload" },
      manager.revisionOf(original.messageId),
    );
    await writeStarted;
    const enqueue = manager.enqueue(replacement);
    resumeWrite();

    await expect(update).resolves.toBe(false);
    expect(writes).toEqual([original.text, "stale upload", "newer edit", "newer edit"]);
    await enqueue;
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [replacement],
    });
    registry.dispose();
  });
  it("refuses to remove a message that was rewritten after the removal decision", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => ({ messages: [...stored.values()], errors: [] }),
        write: async (message) => {
          stored.set(message.messageId, message);
        },
        remove: async (message) => {
          stored.delete(message.messageId);
        },
      },
    });
    const original = queuedMessage({
      messageId: "message-remove-race",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const edited = { ...original, text: "edited while restoring" };

    await manager.enqueue(original);
    const revision = manager.revisionOf(original.messageId);
    await manager.update(edited);

    await expect(manager.remove(original, revision)).resolves.toBe(null);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [edited],
    });
    expect(stored.get(original.messageId)).toEqual(edited);

    await expect(manager.remove(edited, manager.revisionOf(edited.messageId))).resolves.toEqual(
      edited,
    );
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    registry.dispose();
  });
  it("keeps a retry enqueued when its publish races a revision-checked removal", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const removeStarted = Promise.withResolvers<void>();
    const removeBarrier = Promise.withResolvers<void>();
    const replacementWriteStarted = Promise.withResolvers<void>();
    const replacementWriteBarrier = Promise.withResolvers<void>();
    const original = queuedMessage({
      messageId: "message-remove-enqueue-race",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const retried = { ...original, text: "retried" };
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => ({ messages: [...stored.values()], errors: [] }),
        write: async (message) => {
          if (message === retried) {
            replacementWriteStarted.resolve();
            await replacementWriteBarrier.promise;
          }
          stored.set(message.messageId, message);
        },
        remove: async (message) => {
          removeStarted.resolve();
          await removeBarrier.promise;
          stored.delete(message.messageId);
        },
      },
    });

    await manager.enqueue(original);
    const removal = manager.remove(original, manager.revisionOf(original.messageId));
    let removalSettled = false;
    void removal.then(() => {
      removalSettled = true;
    });
    await removeStarted.promise;
    const enqueue = manager.enqueue(retried);
    removeBarrier.resolve();
    await replacementWriteStarted.promise;

    expect(removalSettled).toBe(false);
    replacementWriteBarrier.resolve();
    await expect(removal).resolves.toBe(null);
    expect(stored.get(original.messageId)).toEqual(retried);
    await enqueue;
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [retried],
    });
    expect(stored.get(original.messageId)).toEqual(retried);
    registry.dispose();
  });
  it("restores a message when its live removal predicate changes during storage removal", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const removeStarted = Promise.withResolvers<void>();
    const removeBarrier = Promise.withResolvers<void>();
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => ({ messages: [...stored.values()], errors: [] }),
        write: async (message) => {
          stored.set(message.messageId, message);
        },
        remove: async (message) => {
          removeStarted.resolve();
          await removeBarrier.promise;
          stored.delete(message.messageId);
        },
      },
    });
    const message = queuedMessage({
      messageId: "message-remove-predicate-race",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    let canRemove = true;

    await manager.enqueue(message);
    const removal = manager.remove(message, manager.revisionOf(message.messageId), () => canRemove);
    await removeStarted.promise;
    canRemove = false;
    removeBarrier.resolve();

    await expect(removal).resolves.toBe(null);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });
    expect(stored.get(message.messageId)).toEqual(message);
    registry.dispose();
  });
  it("preserves concurrent enqueues while clearing an environment", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const removeStarted = Promise.withResolvers<void>();
    const removeBarrier = Promise.withResolvers<void>();
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => ({ messages: [...stored.values()], errors: [] }),
        write: async (message) => {
          stored.set(message.messageId, message);
        },
        remove: async (message) => {
          if (message.environmentId === EnvironmentId.make("environment-clear")) {
            removeStarted.resolve();
            await removeBarrier.promise;
          }
          stored.delete(message.messageId);
        },
      },
    });
    const replaced = queuedMessage({
      environmentId: "environment-clear",
      messageId: "message-replaced-during-clear",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const removed = queuedMessage({
      environmentId: "environment-clear",
      messageId: "message-removed-by-clear",
      createdAt: "2026-06-08T10:00:02.000Z",
    });
    const kept = queuedMessage({
      environmentId: "environment-keep",
      messageId: "message-other-environment",
      createdAt: "2026-06-08T10:00:03.000Z",
    });
    const replacement = { ...replaced, text: "replacement" };
    const added = queuedMessage({
      environmentId: "environment-clear",
      messageId: "message-added-during-clear",
      createdAt: "2026-06-08T10:00:04.000Z",
    });

    await Promise.all([manager.enqueue(replaced), manager.enqueue(removed), manager.enqueue(kept)]);
    const clearing = manager.clearEnvironment(replaced.environmentId);
    await removeStarted.promise;
    const replacing = manager.enqueue(replacement);
    const adding = manager.enqueue(added);
    removeBarrier.resolve();

    await expect(clearing).resolves.toEqual([removed]);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-clear:thread-1": [replacement, added],
      "environment-keep:thread-1": [kept],
    });
    expect(stored.get(replacement.messageId)).toEqual(replacement);
    expect(stored.has(removed.messageId)).toBe(false);

    await Promise.all([replacing, adding]);
    expect([...stored.values()]).toEqual(expect.arrayContaining([replacement, added, kept]));
    registry.dispose();
  });
  it("does not restore a message removed before a queued environment clear starts", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const removeStarted = Promise.withResolvers<void>();
    const removeBarrier = Promise.withResolvers<void>();
    let removeCalls = 0;
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => ({ messages: [...stored.values()], errors: [] }),
        write: async (message) => {
          stored.set(message.messageId, message);
        },
        remove: async (message) => {
          removeCalls += 1;
          if (removeCalls === 1) {
            removeStarted.resolve();
            await removeBarrier.promise;
          }
          stored.delete(message.messageId);
        },
      },
    });
    const message = queuedMessage({
      environmentId: "environment-clear",
      messageId: "message-removed-before-clear",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    await manager.enqueue(message);
    const removal = manager.remove(message);
    await removeStarted.promise;
    const clearing = manager.clearEnvironment(message.environmentId);
    removeBarrier.resolve();

    await expect(removal).resolves.toEqual(message);
    await expect(clearing).resolves.toEqual([]);
    expect(removeCalls).toBe(1);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    expect(stored.has(message.messageId)).toBe(false);
    registry.dispose();
  });
  it("keeps an enqueue published while an environment clear waits to start", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const mutationStarted = Promise.withResolvers<void>();
    const mutationBarrier = Promise.withResolvers<void>();
    let removeCalls = 0;
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => ({ messages: [...stored.values()], errors: [] }),
        write: async (message) => {
          stored.set(message.messageId, message);
        },
        remove: async () => {
          removeCalls += 1;
        },
      },
    });
    const blocker = manager.serialize(async () => {
      mutationStarted.resolve();
      await mutationBarrier.promise;
    });
    await mutationStarted.promise;
    const clearing = manager.clearEnvironment(EnvironmentId.make("environment-clear"));
    const added = queuedMessage({
      environmentId: "environment-clear",
      messageId: "message-enqueued-before-clear-start",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const enqueue = manager.enqueue(added);
    mutationBarrier.resolve();

    await blocker;
    await expect(clearing).resolves.toEqual([]);
    expect(removeCalls).toBe(0);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-clear:thread-1": [added],
    });
    await enqueue;
    expect(stored.get(added.messageId)).toEqual(added);
    registry.dispose();
  });
  it("removes an already-created pending task before the file-capability gate runs", () => {
    const fileAttachments = [{ name: "report.pdf", sizeBytes: 42 }];
    expect(
      resolveThreadOutboxDispatchStep({
        deliveryAction: "remove",
        fileAttachments,
        serverConfig: null,
      }),
    ).toEqual({ step: "remove" });
    expect(
      resolveThreadOutboxDispatchStep({
        deliveryAction: "remove",
        fileAttachments,
        serverConfig: { maxFileUploadBytes: undefined },
      }),
    ).toEqual({ step: "remove" });
  });
  it("retries instead of parking a file message while the server config loads", () => {
    expect(
      resolveThreadOutboxDispatchStep({
        deliveryAction: "send",
        fileAttachments: [{ name: "report.pdf", sizeBytes: 42 }],
        serverConfig: null,
      }),
    ).toEqual({ step: "retry" });
  });
  it("gates a sending file message on the server's file support and limit", () => {
    expect(
      resolveThreadOutboxDispatchStep({
        deliveryAction: "send",
        fileAttachments: [{ name: "report.pdf", sizeBytes: 42 }],
        serverConfig: { maxFileUploadBytes: undefined },
      }),
    ).toEqual({ step: "restore", reason: "This server does not support file attachments." });
    expect(
      resolveThreadOutboxDispatchStep({
        deliveryAction: "send",
        fileAttachments: [{ name: "big.zip", sizeBytes: 2 * 1024 * 1024 }],
        serverConfig: { maxFileUploadBytes: 1024 * 1024 },
      }),
    ).toEqual({ step: "restore", reason: "'big.zip' exceeds the 1 MB attachment limit." });
    expect(
      resolveThreadOutboxDispatchStep({
        deliveryAction: "send",
        fileAttachments: [{ name: "report.pdf", sizeBytes: 42 }],
        serverConfig: { maxFileUploadBytes: 1024 * 1024 },
      }),
    ).toEqual({ step: "send" });
  });
  it("only removes a missing-thread message after shell synchronization is live", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: false,
        shellStatus: "synchronizing",
        environmentConnected: true,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
      }),
    ).toBe("remove");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
      }),
    ).toBe("send");
  });
  it("removes a missing-thread message only after a settled family read when idle children can be omitted", () => {
    const missing = {
      isCreation: false,
      threadExists: false,
      shellStatus: "live",
      environmentConnected: true,
    } as const;
    expect(resolveThreadOutboxDeliveryAction({ ...missing, familyRead: "pending" })).toBe("wait");
    expect(resolveThreadOutboxDeliveryAction({ ...missing, familyRead: "failed" })).toBe("wait");
    expect(resolveThreadOutboxDeliveryAction({ ...missing, familyRead: "settled" })).toBe("remove");
  });
  it("sends existing-thread messages whenever connected so queued messages can steer", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
      }),
    ).toBe("send");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: false,
      }),
    ).toBe("wait");
  });
  it("sends queued creations once connected and live, removing already-created ones", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "cached",
        environmentConnected: false,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "synchronizing",
        environmentConnected: true,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
      }),
    ).toBe("send");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
      }),
    ).toBe("remove");
  });
});

