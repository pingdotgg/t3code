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
  it("retains structured context through a persisted offline queue round trip", () => {
    const message: QueuedThreadMessage = {
      ...queuedMessage({ messageId: "context-message", createdAt: "2026-09-06T12:00:00.000Z" }),
      text: "[Build](t3-context://v1/terminal/build-output)",
      context: {
        version: 1,
        records: [
          {
            version: 1,
            kind: "terminal",
            contextId: ComposerContextId.make("build-output"),
            label: "Build",
            terminalId: "main",
            terminalLabel: "Terminal",
            lineStart: 2,
            lineEnd: 2,
            text: "Build failed",
          },
        ],
      },
    };
    expect(
      decodeQueuedThreadMessage(JSON.parse(JSON.stringify(encodeQueuedThreadMessage(message)))),
    ).toEqual(message);
  });
  it.each(["read", "json", "schema"] as const)(
    "recovers usable messages without permitting cleanup after a record %s failure",
    async (failure) => {
      onTestFinished(() => outboxFiles.clear());
      const first = queuedMessage({
        messageId: "message-1",
        createdAt: "2026-06-08T10:00:01.000Z",
      });
      const second = queuedMessage({
        environmentId: "environment-2",
        messageId: "message-2",
        createdAt: "2026-06-08T10:00:02.000Z",
      });
      outboxFiles.set(
        "message-2.json",
        failure === "read"
          ? new Error("storage unavailable")
          : failure === "json"
            ? "{"
            : JSON.stringify({ ...second, schemaVersion: 999 }),
      );
      outboxFiles.set("message-1.json", JSON.stringify(encodeQueuedThreadMessage(first)));
      const unreadable = outboxFiles.get("message-2.json");

      await expect(expoThreadOutboxStorage.load()).resolves.toMatchObject({
        messages: [first],
        errors: [{ operation: "read-message", fileName: "message-2.json" }],
      });

      const registry = AtomRegistry.make();
      onTestFinished(() => registry.dispose());
      const manager = createThreadOutboxManager({
        registry,
        storage: expoThreadOutboxStorage,
        warn: () => {},
      });
      await expect(manager.load()).resolves.toBe(false);
      const recovered = registry.get(manager.queuedMessagesByThreadKeyAtom)[
        "environment-1:thread-1"
      ]![0]!;
      expect(recovered).toEqual(first);
      await expect(manager.confirmQueued(recovered)).resolves.toBe(true);
      const edited = { ...recovered, text: "Edited after recovery" };
      await expect(manager.update(edited)).resolves.toBe(true);
      const beforeRetry = registry.get(manager.queuedMessagesByThreadKeyAtom);
      await expect(manager.load()).resolves.toBe(false);
      expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toBe(beforeRetry);
      await expect(manager.clearEnvironment(first.environmentId)).rejects.toMatchObject({
        operation: "clear-environment-load",
      });
      expect(outboxFiles.get("message-2.json")).toBe(unreadable);
      expect(outboxFiles.has("message-1.json")).toBe(true);

      await expect(manager.remove(edited)).resolves.toBe(edited);
      expect(outboxFiles.has("message-1.json")).toBe(false);

      outboxFiles.set("message-2.json", JSON.stringify(encodeQueuedThreadMessage(second)));
      await expect(manager.load()).resolves.toBe(true);
      expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
        "environment-2:thread-1": [second],
      });
      await expect(expoThreadOutboxStorage.load()).resolves.toEqual({
        messages: [second],
        errors: [],
      });
    },
  );
  it("preserves queued messages when environment cleanup cannot read the outbox", async () => {
    const registry = AtomRegistry.make();
    onTestFinished(() => registry.dispose());
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const manager = createThreadOutboxManager({
      registry,
      warn: () => {},
      storage: {
        load: async () => {
          throw new Error("storage unavailable");
        },
        write: async (entry) => {
          stored.set(entry.messageId, entry);
        },
        remove: async (entry) => {
          stored.delete(entry.messageId);
        },
      },
    });
    await manager.enqueue(message);

    await expect(manager.clearEnvironment(message.environmentId)).rejects.toMatchObject({
      operation: "clear-environment-load",
    });
    expect([...stored.values()]).toEqual([message]);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });
  });
  it("keeps in-session edits and removals when an incomplete load is retried", async () => {
    const registry = AtomRegistry.make();
    onTestFinished(() => registry.dispose());
    const message = queuedMessage({
      messageId: "message-retried",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<ThreadOutboxLoadResult>();
    const load = vi.fn<ThreadOutboxStorage["load"]>(async () => ({
      messages: [message],
      errors: [],
    }));
    load.mockImplementationOnce(() => {
      started.resolve();
      return response.promise;
    });
    const manager = createThreadOutboxManager({
      registry,
      storage: { load, write: async () => {}, remove: async () => {} },
      warn: () => {},
    });
    const loading = manager.load();
    await started.promise;
    const edited = { ...message, text: "Accepted while storage was being read" };
    const writing = manager.enqueue(edited);
    response.resolve({
      messages: [message],
      errors: [
        new ThreadOutboxStorageError({
          operation: "read-message",
          environmentId: null,
          threadId: null,
          messageId: null,
          fileName: "unreadable.json",
          cause: new Error("unreadable record"),
        }),
      ],
    });
    await expect(loading).resolves.toBe(false);
    await writing;
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [edited],
    });
    await expect(manager.confirmQueued(edited)).resolves.toBe(true);

    await manager.remove(edited);
    await expect(manager.load()).resolves.toBe(true);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("reads file-backed images from v4 queued messages", () => {
    const message = {
      ...queuedMessage({
        messageId: "message-image",
        createdAt: "2026-06-08T10:00:01.000Z",
      }),
      attachments: [
        {
          id: "image-1",
          type: "image" as const,
          name: "photo.png",
          mimeType: "image/png",
          sizeBytes: 3,
          fileUri: "file:///documents/t3-composer-attachments/photo.png",
          previewUri: "file:///documents/t3-composer-attachments/photo.png",
          uploadedAttachmentId: "pending-photo-png",
          uploadEnvironmentId: EnvironmentId.make("environment-1"),
        },
      ],
    } satisfies QueuedThreadMessage;

    expect(decodeQueuedThreadMessage({ ...message, schemaVersion: 4 })).toEqual(message);
  });
  it("persists the exact selector snapshot while remaining compatible with v1 messages", () => {
    const legacyMessage = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const selectedMessage = {
      ...legacyMessage,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    } satisfies QueuedThreadMessage;

    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(selectedMessage))).toEqual(
      selectedMessage,
    );
    expect(
      resolveQueuedThreadSettings(legacyMessage, {
        modelSelection: selectedMessage.modelSelection,
        runtimeMode: selectedMessage.runtimeMode,
        interactionMode: selectedMessage.interactionMode,
      }),
    ).toEqual({
      modelSelection: selectedMessage.modelSelection,
      runtimeMode: selectedMessage.runtimeMode,
      interactionMode: selectedMessage.interactionMode,
    });
  });
  it("normalizes queued plan mode against the queued provider, not the current thread", () => {
    const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" };
    const antigravity = {
      instanceId: ProviderInstanceId.make("google-personal"),
      model: "gemini-test-thinking",
      options: [{ id: "native-option", value: "keep-this-choice" }],
    };
    const providers = [
      { instanceId: codex.instanceId, showInteractionModeToggle: true },
      { instanceId: antigravity.instanceId, showInteractionModeToggle: false },
    ];
    const message = {
      ...queuedMessage({ messageId: "queued-plan", createdAt: "2026-09-02T10:00:00.000Z" }),
      text: "/plan inspect the project",
      modelSelection: antigravity,
      interactionMode: "plan",
    } satisfies QueuedThreadMessage;

    expect(
      resolveQueuedThreadSettings(
        message,
        { modelSelection: codex, runtimeMode: "approval-required", interactionMode: "plan" },
        providers,
      ),
    ).toEqual({
      modelSelection: antigravity,
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
    expect(
      resolveQueuedThreadSettings(
        { ...message, modelSelection: codex },
        {
          modelSelection: antigravity,
          runtimeMode: "approval-required",
          interactionMode: "default",
        },
        providers,
      ).interactionMode,
    ).toBe("plan");
  });
  it("holds the mutation queue while persisted messages are loading", async () => {
    const registry = AtomRegistry.make();
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const stored = new Map([[message.messageId, message]]);
    let loadCalls = 0;
    let removeCalls = 0;
    let releaseInitialLoad!: () => void;
    const initialLoadBlocked = new Promise<void>((resolve) => {
      releaseInitialLoad = resolve;
    });
    const storage: ThreadOutboxStorage = {
      load: async () => {
        loadCalls += 1;
        if (loadCalls === 1) {
          await initialLoadBlocked;
        }
        return { messages: [...stored.values()], errors: [] };
      },
      write: async () => undefined,
      remove: async (candidate) => {
        removeCalls += 1;
        stored.delete(candidate.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });

    const loading = manager.load();
    await Promise.resolve();
    const clearing = manager.clearEnvironment(message.environmentId);
    await Promise.resolve();
    await Promise.resolve();

    expect(loadCalls).toBe(1);
    expect(removeCalls).toBe(0);

    releaseInitialLoad();
    await Promise.all([loading, clearing]);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    registry.dispose();
  });
  it("reports structured load failures and permits a retry", async () => {
    const registry = AtomRegistry.make();
    const loadCause = new Error("storage unavailable");
    const warnings: Array<{ message: string; error: unknown }> = [];
    let loadCalls = 0;
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => {
          loadCalls += 1;
          if (loadCalls === 1) throw loadCause;
          return { messages: [], errors: [] };
        },
        write: async () => undefined,
        remove: async () => undefined,
      },
      warn: (message, error) => warnings.push({ message, error }),
    });

    await manager.load();
    expect(warnings).toEqual([
      {
        message: "[thread-outbox] failed to load persisted messages",
        error: new ThreadOutboxManagerError({
          operation: "load",
          environmentId: null,
          threadId: null,
          messageId: null,
          cause: loadCause,
        }),
      },
    ]);

    await manager.load();
    expect(loadCalls).toBe(2);
    registry.dispose();
  });
  it("keeps atom state aligned with durable writes and removals", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const removalCause = new Error("remove failed");
    let failRemoval = true;
    const storage: ThreadOutboxStorage = {
      load: async () => ({ messages: [...stored.values()], errors: [] }),
      write: async (message) => {
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        if (failRemoval) {
          throw removalCause;
        }
        stored.delete(message.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    await manager.enqueue(message);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });

    await expect(manager.remove(message)).rejects.toEqual(
      new ThreadOutboxManagerError({
        operation: "remove",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        cause: removalCause,
      }),
    );
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });

    failRemoval = false;
    await manager.remove(message);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    registry.dispose();
  });
  it("publishes an enqueued message before the durable write resolves", async () => {
    const registry = AtomRegistry.make();
    let releaseWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => ({ messages: [], errors: [] }),
        write: async () => writeBlocked,
        remove: async () => undefined,
      },
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    const enqueueing = manager.enqueue(message);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });

    releaseWrite();
    await enqueueing;
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });
    registry.dispose();
  });
  it("rolls an enqueued message back out when the durable write fails", async () => {
    const registry = AtomRegistry.make();
    const writeCause = new Error("disk full");
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => ({ messages: [], errors: [] }),
        write: async () => {
          throw writeCause;
        },
        remove: async () => undefined,
      },
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    await expect(manager.enqueue(message)).rejects.toEqual(
      new ThreadOutboxManagerError({
        operation: "enqueue",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        cause: writeCause,
      }),
    );
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    registry.dispose();
  });
  it("drops the disk entry when a failed enqueue leaves no queued message behind", async () => {
    const registry = AtomRegistry.make();
    const removed: string[] = [];
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => ({ messages: [], errors: [] }),
        write: async () => {
          throw new Error("disk full");
        },
        remove: async (message) => {
          removed.push(message.messageId);
        },
      },
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    await expect(manager.enqueue(message)).rejects.toBeInstanceOf(ThreadOutboxManagerError);
    expect(removed).toEqual(["message-1"]);
    registry.dispose();
  });
  it("keeps a same-id retry queued when the first attempt's write fails", async () => {
    const registry = AtomRegistry.make();
    let failNextWrite = true;
    let releaseFirstWrite!: () => void;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => ({ messages: [], errors: [] }),
        write: async () => {
          if (failNextWrite) {
            failNextWrite = false;
            await firstWriteBlocked;
            throw new Error("disk full");
          }
        },
        remove: async () => undefined,
      },
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const retried = { ...message, text: "retried" };

    const first = manager.enqueue(message);
    const second = manager.enqueue(retried);
    releaseFirstWrite();
    await expect(first).rejects.toBeInstanceOf(ThreadOutboxManagerError);
    await second;

    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [retried],
    });
    await expect(manager.confirmQueued(retried)).resolves.toBe(true);
    await expect(manager.confirmQueued(message)).resolves.toBe(false);
    registry.dispose();
  });
});

