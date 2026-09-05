import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
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
  groupQueuedThreadMessages,
  isQueuedThreadCreationSendable,
  modelSelectionsEqual,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxDispatchStep,
  resolveThreadOutboxFailureAction,
  resolveQueuedThreadSettings,
  shouldRetryThreadOutboxDelivery,
  threadOutboxRetryDelayMs,
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
      // Put the unreadable record first to check that later records still load.
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

      // A delivered readable message can leave the queue while the failed
      // record stays intact. Its attachment cleanup has a separate guard.
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
    // A later repaired record can contain a stale copy of a removed message.
    await expect(manager.load()).resolves.toBe(true);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("groups messages by scoped thread and preserves creation order", () => {
    const later = queuedMessage({
      messageId: "message-2",
      createdAt: "2026-06-08T10:00:02.000Z",
    });
    const earlier = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    expect(groupQueuedThreadMessages([later, earlier])).toEqual({
      "environment-1:thread-1": [earlier, later],
    });
  });

  it("decodes the persisted schema and rejects incomplete messages", () => {
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    expect(
      decodeQueuedThreadMessage({
        schemaVersion: 1,
        ...message,
      }),
    ).toEqual(message);
    expect(() =>
      decodeQueuedThreadMessage({
        schemaVersion: 1,
        environmentId: "environment-1",
      }),
    ).toThrow();
  });

  it("persists generic attachment paths without embedding their contents", () => {
    const message = {
      ...queuedMessage({
        messageId: "message-file",
        createdAt: "2026-06-08T10:00:01.000Z",
      }),
      attachments: [
        {
          id: "file-1",
          type: "file" as const,
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 42,
          fileUri: "file:///documents/report.pdf",
          uploadedAttachmentId: "pending-report-pdf",
          uploadEnvironmentId: EnvironmentId.make("environment-1"),
        },
      ],
    } satisfies QueuedThreadMessage;

    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(message))).toEqual(message);
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

  it("compares model options as part of the queued settings change", () => {
    const base = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "medium" }],
    } as const;

    expect(modelSelectionsEqual(base, base)).toBe(true);
    expect(
      modelSelectionsEqual(base, {
        ...base,
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      }),
    ).toBe(false);
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

  it("normalizes a legacy queued message that inherits unsupported plan mode", () => {
    const modelSelection = {
      instanceId: ProviderInstanceId.make("google-personal"),
      model: "gemini-test-thinking",
    };
    expect(
      resolveQueuedThreadSettings(
        queuedMessage({ messageId: "legacy-plan", createdAt: "2026-09-02T10:00:00.000Z" }),
        { modelSelection, runtimeMode: "approval-required", interactionMode: "plan" },
        [{ instanceId: modelSelection.instanceId, showInteractionModeToggle: false }],
      ).interactionMode,
    ).toBe("default");
  });

  it("backs off queued delivery retries and caps them at sixteen seconds", () => {
    expect([1, 2, 3, 4, 5, 6].map(threadOutboxRetryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 16_000,
    ]);
  });

  it("serializes mutations even when an earlier mutation is slower", async () => {
    const registry = AtomRegistry.make();
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => ({ messages: [], errors: [] }),
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = manager.serialize(async () => {
      order.push("first:start");
      await firstBlocked;
      order.push("first:end");
    });
    const second = manager.serialize(async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    registry.dispose();
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

    // A concurrent update losing its race can compensate-write this payload
    // to disk before this write fails; rollback must clear that copy or a
    // restart resurrects the message.
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

    // The failed first attempt must not roll back the retry that replaced it.
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [retried],
    });
    await expect(manager.confirmQueued(retried)).resolves.toBe(true);
    await expect(manager.confirmQueued(message)).resolves.toBe(false);
    registry.dispose();
  });

  it("replaces an existing message when an enqueue retry uses the same id", async () => {
    const registry = AtomRegistry.make();
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => ({ messages: [], errors: [] }),
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const retried = { ...message, text: "retried" };

    await manager.enqueue(message);
    await manager.enqueue(retried);

    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [retried],
    });
    registry.dispose();
  });

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
    // Revision captured before slow work (an attachment upload) starts.
    const revision = manager.revisionOf(original.messageId);
    await manager.update(edited);

    await expect(manager.update({ ...original, text: "stale upload" }, revision)).resolves.toBe(
      false,
    );
    // The losing writer was rejected before persisting: no stale payload can
    // sit on disk waiting to resurrect on the next load.
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
    // The losing update re-writes the winning payload inside its own
    // mutation, before the replacement's serialized write lands, so a crash
    // between the two cannot leave the stale payload on disk.
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
    // Revision captured when restore-to-composer read the payload it intends
    // to remove; the edit accepted afterwards must survive the removal.
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
    // Published synchronously while the durable remove is still in flight.
    const enqueue = manager.enqueue(retried);
    removeBarrier.resolve();
    await replacementWriteStarted.promise;

    // The canceled removal itself restores the durable winner. The queued
    // enqueue write has not had a chance to run yet.
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
    // The creation's startTurn already made the thread, so the resolver wants
    // the queued message removed. A missing server config (or missing file
    // support) must not turn that into a restore, which would duplicate the
    // task as a draft.
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

  it("waits for provider capabilities before sending text-only queued messages", () => {
    expect(
      resolveThreadOutboxDispatchStep({
        deliveryAction: "send",
        fileAttachments: [],
        serverConfig: null,
      }),
    ).toEqual({ step: "retry" });
    expect(
      resolveThreadOutboxDispatchStep({
        deliveryAction: "send",
        fileAttachments: [],
        serverConfig: { maxFileUploadBytes: undefined },
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
        threadBusy: false,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("remove");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("send");
  });

  it("sends existing-thread messages whenever connected so queued messages can steer", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: true,
      }),
    ).toBe("send");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: false,
        threadBusy: true,
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
        threadBusy: false,
      }),
    ).toBe("wait");
    // Connected but not yet synchronized: a previously delivered creation may
    // simply not be visible yet — sending now could duplicate the thread.
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "synchronizing",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("send");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: true,
      }),
    ).toBe("remove");
  });

  it("round-trips queued creations and gates incomplete ones from sending", () => {
    const base = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const creationMessage = {
      ...base,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      creation: {
        projectId: ProjectId.make("project-1"),
        workspaceMode: "worktree",
        branch: "main",
        worktreePath: null,
        startFromOrigin: true,
      },
    } satisfies QueuedThreadMessage;

    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(creationMessage))).toEqual(
      creationMessage,
    );
    expect(isQueuedThreadCreationSendable(creationMessage)).toBe(true);
    expect(
      isQueuedThreadCreationSendable({
        ...creationMessage,
        creation: { ...creationMessage.creation, branch: null },
      }),
    ).toBe(false);
    expect(
      isQueuedThreadCreationSendable({
        ...creationMessage,
        creation: { ...creationMessage.creation, branch: "" },
      }),
    ).toBe(false);
    expect(isQueuedThreadCreationSendable({ ...creationMessage, modelSelection: undefined })).toBe(
      false,
    );
    expect(isQueuedThreadCreationSendable(base)).toBe(false);
  });

  it("retries transport failures but drops deterministic command failures", () => {
    expect(shouldRetryThreadOutboxDelivery(new Error("Socket is not connected"))).toBe(true);
    expect(
      shouldRetryThreadOutboxDelivery({
        _tag: "ConnectionTransientError",
        message: "temporarily unavailable",
      }),
    ).toBe(true);
    expect(shouldRetryThreadOutboxDelivery(new Error("Thread no longer exists"))).toBe(false);
  });

  it("retains queued messages when settings synchronization fails before startTurn", () => {
    const deterministicFailure = new Error("Thread no longer exists");

    expect(
      resolveThreadOutboxFailureAction({
        stage: "settings-sync",
        error: deterministicFailure,
        interrupted: false,
      }),
    ).toBe("retry");
    expect(
      resolveThreadOutboxFailureAction({
        stage: "start-turn",
        error: deterministicFailure,
        interrupted: false,
      }),
    ).toBe("restore");
  });
});
