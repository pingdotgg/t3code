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
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";

import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  flattenQueuedThreadMessages,
  groupQueuedThreadMessages,
  hasSameThreadOutboxUserPayload,
  isOutcomeUnknownThreadOutboxHold,
  isQueuedThreadCreationSendable,
  modelSelectionsEqual,
  queuedWorktreeBranchName,
  resolveQueuedWorktreeBranchName,
  resolveThreadOutboxDeliveryAction,
  shouldQueueThreadCreationForDurableDelivery,
  resolveThreadOutboxFailureAction,
  resolveQueuedThreadSettings,
  shouldRetryThreadOutboxDelivery,
  threadOutboxRetryDelayMs,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import { createThreadOutboxManager, ThreadOutboxManagerError } from "./thread-outbox-manager";
import type { ThreadOutboxStorage } from "./thread-outbox-storage";

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
  it("derives a stable worktree branch from the queued command", () => {
    const commandId = CommandId.make("12345678-abcd-4000-8000-123456789abc");

    expect(queuedWorktreeBranchName(commandId)).toBe("t3code/12345678");
    expect(queuedWorktreeBranchName(commandId)).toBe(queuedWorktreeBranchName(commandId));
    expect(isTemporaryWorktreeBranch(queuedWorktreeBranchName(commandId))).toBe(true);
    expect(resolveQueuedWorktreeBranchName(commandId, undefined)).toBe("t3code/12345678");
    expect(resolveQueuedWorktreeBranchName(commandId, "t3code/abcdef12")).toBe("t3code/abcdef12");
    expect(
      isTemporaryWorktreeBranch(queuedWorktreeBranchName(CommandId.make("command-alpha"))),
    ).toBe(true);
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

  it("round-trips a durable manual delivery hold", () => {
    const heldMessage = {
      ...queuedMessage({
        messageId: "message-1",
        createdAt: "2026-06-08T10:00:01.000Z",
      }),
      deliveryHoldReason: "deduplication-window-changed",
    } satisfies QueuedThreadMessage;

    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(heldMessage))).toEqual(heldMessage);
  });

  it("round-trips the process-local pre-dispatch marker", () => {
    const markedMessage = {
      ...queuedMessage({
        messageId: "message-1",
        createdAt: "2026-06-08T10:00:01.000Z",
      }),
      deliveryHoldReason: "process-local-dispatch-started",
    } satisfies QueuedThreadMessage;

    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(markedMessage))).toEqual(
      markedMessage,
    );
    expect(isOutcomeUnknownThreadOutboxHold(markedMessage)).toBe(true);
    expect(
      isOutcomeUnknownThreadOutboxHold({
        ...markedMessage,
        deliveryHoldReason: "process-local-definite-failure",
      }),
    ).toBe(true);
  });

  it("routes connected worktree creation through the durable outbox", () => {
    expect(
      shouldQueueThreadCreationForDurableDelivery({
        environmentConnected: true,
        workspaceMode: "worktree",
        exactHeldReplay: false,
      }),
    ).toBe(true);
    expect(
      shouldQueueThreadCreationForDurableDelivery({
        environmentConnected: true,
        workspaceMode: "local",
        exactHeldReplay: false,
      }),
    ).toBe(false);
    expect(
      shouldQueueThreadCreationForDurableDelivery({
        environmentConnected: true,
        workspaceMode: "worktree",
        exactHeldReplay: true,
      }),
    ).toBe(false);
  });

  it("detects edits that cannot reuse an outcome-unknown command receipt", () => {
    const original = {
      ...queuedMessage({
        messageId: "message-1",
        createdAt: "2026-06-08T10:00:01.000Z",
      }),
      creation: {
        projectId: ProjectId.make("project-1"),
        projectCwd: "/old/project",
        workspaceMode: "worktree",
        branch: "main",
        worktreePath: null,
        worktreeBranchName: "t3code/12345678",
      },
    } satisfies QueuedThreadMessage;

    // Process-local resolution metadata is replayed from the immutable row,
    // but is not a user edit.
    expect(
      hasSameThreadOutboxUserPayload(original, {
        ...original,
        creation: { ...original.creation, projectCwd: "/new/project" },
      }),
    ).toBe(true);
    expect(hasSameThreadOutboxUserPayload(original, { ...original, text: "edited" })).toBe(false);
    expect(
      hasSameThreadOutboxUserPayload(original, {
        ...original,
        creation: { ...original.creation, branch: "feature" },
      }),
    ).toBe(false);
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

  it("backs off queued delivery retries and caps them at sixteen seconds", () => {
    expect([1, 2, 3, 4, 5, 6].map(threadOutboxRetryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 16_000,
    ]);
  });

  it("retries while an earlier durable turn is awaiting provider adoption", () => {
    expect(
      shouldRetryThreadOutboxDelivery({
        _tag: "OrchestrationTurnStartPendingError",
        threadId: "thread-1",
      }),
    ).toBe(true);
  });

  it("serializes mutations even when an earlier mutation is slower", async () => {
    const registry = AtomRegistry.make();
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
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
        return [...stored.values()];
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
          return [];
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
      load: async () => [...stored.values()],
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
        load: async () => [],
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
        load: async () => [],
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
        load: async () => [],
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
        load: async () => [],
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
      load: async () => [...stored.values()],
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

  it("persists the process-local marker before the side effect and holds it after recreation", async () => {
    const stored = new Map<MessageId, QueuedThreadMessage>();
    let writeCount = 0;
    let markerWriteStarted!: () => void;
    const markerWriting = new Promise<void>((resolve) => {
      markerWriteStarted = resolve;
    });
    let releaseMarkerWrite!: () => void;
    const markerWriteBlocked = new Promise<void>((resolve) => {
      releaseMarkerWrite = resolve;
    });
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => {
        writeCount += 1;
        if (writeCount === 2) {
          markerWriteStarted();
          await markerWriteBlocked;
        }
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        stored.delete(message.messageId);
      },
    };
    const registry = AtomRegistry.make();
    const manager = createThreadOutboxManager({ registry, storage });
    const message = {
      ...queuedMessage({
        messageId: "message-1",
        createdAt: "2026-06-08T10:00:01.000Z",
      }),
      creation: {
        projectId: ProjectId.make("project-1"),
        workspaceMode: "worktree" as const,
        branch: "main",
        worktreePath: null,
        worktreeBranchName: "t3code/12345678",
      },
    };
    await manager.enqueue(message);
    const resolvedMessage = {
      ...message,
      creation: {
        ...message.creation,
        projectCwd: "/resolved/project",
      },
    };
    let sideEffectCalls = 0;

    const deliveryAtBoundary = manager
      .beginProcessLocalDelivery(resolvedMessage)
      .then((started) => {
        if (started) {
          sideEffectCalls += 1;
        }
      });
    await markerWriting;

    expect(sideEffectCalls).toBe(0);
    expect(stored.get(message.messageId)).toEqual(message);

    releaseMarkerWrite();
    await deliveryAtBoundary;
    expect(sideEffectCalls).toBe(1);
    expect(stored.get(message.messageId)?.deliveryHoldReason).toBe(
      "process-local-dispatch-started",
    );
    expect(stored.get(message.messageId)?.creation).toEqual(resolvedMessage.creation);

    // Model a process death exactly after the external side effect starts,
    // before any RPC outcome is observed.
    registry.dispose();
    const recreatedRegistry = AtomRegistry.make();
    const recreatedManager = createThreadOutboxManager({ registry: recreatedRegistry, storage });
    await recreatedManager.load();
    const [recreatedMessage] = flattenQueuedThreadMessages(
      recreatedRegistry.get(recreatedManager.queuedMessagesByThreadKeyAtom),
    );
    expect(recreatedMessage?.deliveryHoldReason).toBe("process-local-dispatch-started");
    expect(
      resolveThreadOutboxDeliveryAction({
        held: recreatedMessage?.deliveryHoldReason !== undefined,
        isCreation: true,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("wait");
    recreatedRegistry.dispose();
  });

  it("never dispatches a stale edit or lets a trailing edit clear a process-local hold", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [...stored.values()],
        write: async (message) => {
          stored.set(message.messageId, message);
        },
        remove: async (message) => {
          stored.delete(message.messageId);
        },
      },
    });
    const original = {
      ...queuedMessage({
        messageId: "message-stale-marker",
        createdAt: "2026-06-08T10:00:01.000Z",
      }),
      creation: {
        projectId: ProjectId.make("project-1"),
        workspaceMode: "worktree" as const,
        branch: "main",
        worktreePath: null,
        worktreeBranchName: "t3code/12345678",
      },
    };
    const edited = { ...original, text: "newer edit" };
    const resolvedOriginal = {
      ...original,
      creation: { ...original.creation, projectCwd: "/resolved/project" },
    };

    await manager.enqueue(original);
    await manager.update(edited);
    await expect(manager.beginProcessLocalDelivery(resolvedOriginal)).resolves.toBe(false);
    expect(stored.get(original.messageId)).toEqual(edited);

    const resolvedEdit = {
      ...edited,
      creation: { ...edited.creation, projectCwd: "/resolved/project" },
    };
    await expect(manager.beginProcessLocalDelivery(resolvedEdit)).resolves.toBe(true);
    await expect(manager.update({ ...edited, text: "late flush" })).resolves.toBe(false);
    expect(stored.get(original.messageId)).toMatchObject({
      text: "newer edit",
      deliveryHoldReason: "process-local-dispatch-started",
      creation: { projectCwd: "/resolved/project" },
    });
    registry.dispose();
  });

  it("does not cross the process-local side-effect boundary when marker persistence fails", async () => {
    const registry = AtomRegistry.make();
    const writeCause = new Error("disk full");
    let failWrites = false;
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => {
          if (failWrites) {
            throw writeCause;
          }
        },
        remove: async () => undefined,
      },
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    await manager.enqueue(message);
    failWrites = true;
    let sideEffectCalls = 0;

    await expect(
      manager.beginProcessLocalDelivery(message).then(() => {
        sideEffectCalls += 1;
      }),
    ).rejects.toEqual(
      new ThreadOutboxManagerError({
        operation: "begin-process-local-delivery",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        cause: writeCause,
      }),
    );

    expect(sideEffectCalls).toBe(0);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });
    registry.dispose();
  });

  it("keeps the current process held when persisting the safety marker fails", async () => {
    const registry = AtomRegistry.make();
    const writeCause = new Error("disk full");
    let failWrites = false;
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => {
          if (failWrites) {
            throw writeCause;
          }
        },
        remove: async () => undefined,
      },
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    await manager.enqueue(message);
    failWrites = true;
    await expect(manager.hold(message, "deduplication-window-changed")).rejects.toEqual(
      new ThreadOutboxManagerError({
        operation: "hold",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        cause: writeCause,
      }),
    );
    const [heldMessage] = flattenQueuedThreadMessages(
      registry.get(manager.queuedMessagesByThreadKeyAtom),
    );
    expect(heldMessage?.deliveryHoldReason).toBe("deduplication-window-changed");
    registry.dispose();
  });

  it("only removes a missing-thread message after shell synchronization is live", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        held: false,
        isCreation: false,
        threadExists: false,
        shellStatus: "synchronizing",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        held: false,
        isCreation: false,
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("remove");
    expect(
      resolveThreadOutboxDeliveryAction({
        held: false,
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("send");
  });

  it("sends queued creations once connected and removes delivered local creations", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        held: false,
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
        held: false,
        isCreation: true,
        threadExists: false,
        shellStatus: "synchronizing",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        held: false,
        isCreation: true,
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("send");
    expect(
      resolveThreadOutboxDeliveryAction({
        held: false,
        isCreation: true,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: true,
      }),
    ).toBe("remove");
    expect(
      resolveThreadOutboxDeliveryAction({
        held: false,
        isCreation: true,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
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
        worktreeBranchName: "t3/abc12345",
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
    expect(
      shouldRetryThreadOutboxDelivery({
        _tag: "EnvironmentRpcUnavailableError",
        message: "The environment is not connected.",
      }),
    ).toBe(true);
    expect(
      shouldRetryThreadOutboxDelivery({
        _tag: "EnvironmentRpcUnavailableError",
        message: "The backend restarted before the request completed.",
        cause: {
          _tag: "OrchestrationCommandDeduplicationWindowChangedError",
        },
      }),
    ).toBe(false);
    expect(
      shouldRetryThreadOutboxDelivery({
        _tag: "EnvironmentRpcUnavailableError",
        message: "The backend restarted before the request completed.",
        cause: {
          _tag: "OrchestrationDispatchCommandError",
          reason: "deduplication-window-changed",
        },
      }),
    ).toBe(false);
    expect(shouldRetryThreadOutboxDelivery(new Error("Thread no longer exists"))).toBe(false);
  });

  it("retains queued messages when settings synchronization fails before startTurn", () => {
    const deterministicFailure = new Error("Thread no longer exists");
    const processLocalRestartFailure = {
      _tag: "EnvironmentRpcUnavailableError",
      message: "The backend restarted before the request completed.",
      cause: {
        _tag: "OrchestrationCommandDeduplicationWindowChangedError",
      },
    };

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
    ).toBe("discard");
    expect(
      resolveThreadOutboxFailureAction({
        stage: "start-turn",
        error: processLocalRestartFailure,
        interrupted: false,
      }),
    ).toBe("hold");
  });
});
