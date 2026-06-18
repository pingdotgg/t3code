import { describe, expect, it } from "@effect/vitest";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";

import {
  decodeQueuedThreadMessage,
  groupQueuedThreadMessages,
  resolveThreadOutboxDeliveryAction,
  shouldRetryThreadOutboxDelivery,
  threadOutboxRetryDelayMs,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import { createThreadOutboxManager } from "./thread-outbox-manager";
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

  it("keeps atom state aligned with durable writes and removals", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    let failRemoval = true;
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => {
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        if (failRemoval) {
          throw new Error("remove failed");
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

    await expect(manager.remove(message)).rejects.toThrow("remove failed");
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });

    failRemoval = false;
    await manager.remove(message);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    registry.dispose();
  });

  it("only removes a missing-thread message after shell synchronization is live", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        threadExists: false,
        shellStatus: "synchronizing",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("remove");
    expect(
      resolveThreadOutboxDeliveryAction({
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("send");
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
});
