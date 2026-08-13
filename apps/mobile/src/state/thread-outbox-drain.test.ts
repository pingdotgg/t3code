import { describe, expect, it, vi } from "@effect/vitest";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";

import { settleThreadOutboxDelivery } from "./thread-outbox-drain";
import { createThreadOutboxManager } from "./thread-outbox-manager";
import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  flattenQueuedThreadMessages,
  isThreadOutboxDeliveryCleanupPending,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxFailureAction,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import type { ThreadOutboxStorage } from "./thread-outbox-storage";

function queuedMessage(): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make("message-1"),
    commandId: CommandId.make("command-1"),
    text: "Start the task",
    attachments: [],
    createdAt: "2026-08-13T00:00:00.000Z",
  };
}

describe("thread outbox drain", () => {
  it("persists an outcome-unknown bootstrap hold without removing or retrying it", async () => {
    const persisted = new Map<MessageId, unknown>();
    const storage: ThreadOutboxStorage = {
      load: async () => [...persisted.values()].map((value) => decodeQueuedThreadMessage(value)),
      write: async (message) => {
        persisted.set(message.messageId, encodeQueuedThreadMessage(message));
      },
      remove: async (message) => {
        persisted.delete(message.messageId);
      },
    };
    const registry = AtomRegistry.make();
    const manager = createThreadOutboxManager({ registry, storage });
    const message = queuedMessage();
    await manager.enqueue(message);
    const hold = vi.fn((candidate: QueuedThreadMessage) =>
      manager.hold(candidate, "deduplication-window-changed"),
    );
    const remove = vi.fn((candidate: QueuedThreadMessage) => manager.remove(candidate));
    const failureAction = resolveThreadOutboxFailureAction({
      stage: "start-turn",
      interrupted: false,
      error: {
        _tag: "EnvironmentRpcUnavailableError",
        cause: { _tag: "OrchestrationCommandDeduplicationWindowChangedError" },
      },
    });

    const settledWithoutRetry = await settleThreadOutboxDelivery({
      message,
      failureAction,
      hold,
      remove,
      onHoldError: () => undefined,
      onRemoveError: () => undefined,
    });

    expect(settledWithoutRetry).toBe(true);
    expect(hold).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
    registry.dispose();

    const recreatedRegistry = AtomRegistry.make();
    const recreatedManager = createThreadOutboxManager({
      registry: recreatedRegistry,
      storage,
    });
    await recreatedManager.load();
    const [heldMessage] = flattenQueuedThreadMessages(
      recreatedRegistry.get(recreatedManager.queuedMessagesByThreadKeyAtom),
    );
    expect(heldMessage?.deliveryHoldReason).toBe("deduplication-window-changed");
    expect(
      resolveThreadOutboxDeliveryAction({
        held: heldMessage?.deliveryHoldReason !== undefined,
        isCreation: true,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: true,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        held: heldMessage?.deliveryHoldReason !== undefined,
        isCreation: true,
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
    ).toBe("wait");
    recreatedRegistry.dispose();
  });

  it("returns the retry signal without mutating the queued item", async () => {
    const message = queuedMessage();
    const hold = vi.fn(async () => true);
    const remove = vi.fn(async () => undefined);

    await expect(
      settleThreadOutboxDelivery({
        message,
        failureAction: "retry",
        hold,
        remove,
        onHoldError: () => undefined,
        onRemoveError: () => undefined,
      }),
    ).resolves.toBe(false);
    expect(hold).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("retries only local cleanup after a delivered process-local task survives one delete failure", async () => {
    const persisted = new Map<MessageId, unknown>();
    let removeAttempts = 0;
    const storage: ThreadOutboxStorage = {
      load: async () => [...persisted.values()].map((value) => decodeQueuedThreadMessage(value)),
      write: async (message) => {
        persisted.set(message.messageId, encodeQueuedThreadMessage(message));
      },
      remove: async (message) => {
        removeAttempts += 1;
        if (removeAttempts === 1) {
          throw new Error("transient delete failure");
        }
        persisted.delete(message.messageId);
      },
    };
    const registry = AtomRegistry.make();
    const manager = createThreadOutboxManager({ registry, storage });
    const message = queuedMessage();
    await manager.enqueue(message);
    await manager.beginProcessLocalDelivery(message);

    const settled = await settleThreadOutboxDelivery({
      message,
      failureAction: null,
      confirmDelivered: (candidate) =>
        manager.hold(candidate, "delivery-confirmed-cleanup-pending"),
      hold: async () => false,
      remove: (candidate) => manager.remove(candidate),
      onConfirmDeliveredError: () => undefined,
      onHoldError: () => undefined,
      onRemoveError: () => undefined,
    });

    expect(settled).toBe(false);
    expect(removeAttempts).toBe(1);
    expect(decodeQueuedThreadMessage(persisted.get(message.messageId))).toMatchObject({
      deliveryHoldReason: "delivery-confirmed-cleanup-pending",
    });
    registry.dispose();

    // Model a full app restart. Positive delivery knowledge must make the next
    // pass retry storage cleanup directly, never the already-accepted RPC.
    const recreatedRegistry = AtomRegistry.make();
    const recreatedManager = createThreadOutboxManager({
      registry: recreatedRegistry,
      storage,
    });
    await recreatedManager.load();
    const [recreatedMessage] = flattenQueuedThreadMessages(
      recreatedRegistry.get(recreatedManager.queuedMessagesByThreadKeyAtom),
    );
    expect(recreatedMessage).toBeDefined();
    if (!recreatedMessage) {
      recreatedRegistry.dispose();
      return;
    }
    const send = vi.fn(async () => undefined);
    const action = resolveThreadOutboxDeliveryAction({
      held: !isThreadOutboxDeliveryCleanupPending(recreatedMessage),
      deliveryConfirmed: isThreadOutboxDeliveryCleanupPending(recreatedMessage),
      isCreation: true,
      threadExists: false,
      shellStatus: "empty",
      environmentConnected: false,
      threadBusy: false,
    });
    if (action === "remove") {
      await recreatedManager.remove(recreatedMessage);
    } else if (action === "send") {
      await send();
    }

    expect(action).toBe("remove");
    expect(send).not.toHaveBeenCalled();
    expect(removeAttempts).toBe(2);
    expect(persisted.size).toBe(0);
    recreatedRegistry.dispose();
  });
});
