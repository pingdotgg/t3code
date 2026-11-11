import {
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  type OwnedWorkItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

export type OwnedWorkCommand = Extract<
  OrchestrationV2ServerCommand,
  {
    readonly type:
      | "owned-work.assign"
      | "owned-work.claim"
      | "owned-work.progress"
      | "owned-work.handoff"
      | "owned-work.complete"
      | "owned-work.cancel";
  }
>;

const itemsOf = (thread: OrchestrationV2AppThread): ReadonlyArray<OwnedWorkItem> =>
  thread.ownedWorkItems ?? [];

const withItems = (
  thread: OrchestrationV2AppThread,
  items: ReadonlyArray<OwnedWorkItem>,
  now: DateTime.Utc,
) =>
  Result.succeed({
    ...thread,
    ownedWorkItems: [...items],
    updatedAt: now,
  });

const findItem = (items: ReadonlyArray<OwnedWorkItem>, itemId: OwnedWorkItem["id"]) => {
  const index = items.findIndex((item) => item.id === itemId);
  if (index < 0) return Result.fail(`Owned work item ${itemId} was not found.`);
  return Result.succeed({ item: items[index]!, index });
};

const replaceAt = (
  items: ReadonlyArray<OwnedWorkItem>,
  index: number,
  item: OwnedWorkItem,
): ReadonlyArray<OwnedWorkItem> => items.map((candidate, i) => (i === index ? item : candidate));

const isOpen = (status: OwnedWorkItem["status"]) =>
  status === "assigned" ||
  status === "claimed" ||
  status === "in_progress" ||
  status === "handed_off";

const actorOwns = (item: OwnedWorkItem, actorThreadId: string | undefined) => {
  if (actorThreadId === undefined) return true;
  if (item.claimedByThreadId === actorThreadId) return true;
  if (item.status === "assigned" && item.createdByThreadId === actorThreadId) return true;
  return false;
};

/**
 * Applies an owned-work command to the home thread. The orchestrator serializes commands, so
 * claim checks here are what make an item leave the unclaimed queue once.
 */
export function decideOwnedWorkCommand(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly command: OwnedWorkCommand;
  readonly now: DateTime.Utc;
}): Result.Result<OrchestrationV2AppThread, string> {
  const { thread, command, now } = input;
  if (thread.deletedAt !== null) return Result.fail(`Thread ${thread.id} is deleted.`);
  if (thread.archivedAt !== null) {
    return Result.fail("Archived threads cannot change owned work.");
  }

  const items = itemsOf(thread);
  const nowIso = DateTime.formatIso(now);

  switch (command.type) {
    case "owned-work.assign": {
      if (items.some((item) => item.id === command.itemId)) {
        return Result.fail(`Owned work item ${command.itemId} already exists.`);
      }
      const item: OwnedWorkItem = {
        id: command.itemId,
        title: command.title,
        description: command.description,
        status: "assigned",
        assigneeThreadId: command.assigneeThreadId ?? null,
        claimedByThreadId: null,
        progress: null,
        handoffNote: null,
        createdByThreadId: command.createdByThreadId,
        createdAt: nowIso,
        updatedAt: nowIso,
        claimedAt: null,
        completedAt: null,
      };
      return withItems(thread, [...items, item], now);
    }
    case "owned-work.claim": {
      const found = findItem(items, command.itemId);
      if (Result.isFailure(found)) return Result.fail(found.failure);
      const { item, index } = found.success;
      if (item.status !== "assigned" && item.status !== "handed_off") {
        return Result.fail(`Owned work item ${command.itemId} is not claimable (${item.status}).`);
      }
      if (item.assigneeThreadId !== null && item.assigneeThreadId !== command.claimedByThreadId) {
        return Result.fail(`Owned work item ${command.itemId} is assigned to another thread.`);
      }
      return withItems(
        thread,
        replaceAt(items, index, {
          ...item,
          status: "claimed",
          claimedByThreadId: command.claimedByThreadId,
          claimedAt: nowIso,
          updatedAt: nowIso,
        }),
        now,
      );
    }
    case "owned-work.progress": {
      const found = findItem(items, command.itemId);
      if (Result.isFailure(found)) return Result.fail(found.failure);
      const { item, index } = found.success;
      if (!isOpen(item.status) || item.status === "assigned" || item.status === "handed_off") {
        return Result.fail(
          `Owned work item ${command.itemId} must be claimed before progress (${item.status}).`,
        );
      }
      if (!actorOwns(item, command.actorThreadId)) {
        return Result.fail(`Owned work item ${command.itemId} is owned by another thread.`);
      }
      return withItems(
        thread,
        replaceAt(items, index, {
          ...item,
          status: "in_progress",
          progress: command.progress,
          updatedAt: nowIso,
        }),
        now,
      );
    }
    case "owned-work.handoff": {
      const found = findItem(items, command.itemId);
      if (Result.isFailure(found)) return Result.fail(found.failure);
      const { item, index } = found.success;
      if (!isOpen(item.status)) {
        return Result.fail(`Owned work item ${command.itemId} is closed (${item.status}).`);
      }
      if (!actorOwns(item, command.actorThreadId)) {
        return Result.fail(`Owned work item ${command.itemId} is owned by another thread.`);
      }
      if (command.toThreadId === item.claimedByThreadId) {
        return Result.fail("Cannot hand off owned work to its current claimer.");
      }
      return withItems(
        thread,
        replaceAt(items, index, {
          ...item,
          status: "handed_off",
          assigneeThreadId: command.toThreadId,
          claimedByThreadId: null,
          claimedAt: null,
          handoffNote: command.note ?? item.handoffNote,
          updatedAt: nowIso,
        }),
        now,
      );
    }
    case "owned-work.complete": {
      const found = findItem(items, command.itemId);
      if (Result.isFailure(found)) return Result.fail(found.failure);
      const { item, index } = found.success;
      if (!isOpen(item.status) || item.status === "assigned" || item.status === "handed_off") {
        return Result.fail(
          `Owned work item ${command.itemId} must be claimed before complete (${item.status}).`,
        );
      }
      if (!actorOwns(item, command.actorThreadId)) {
        return Result.fail(`Owned work item ${command.itemId} is owned by another thread.`);
      }
      return withItems(
        thread,
        replaceAt(items, index, {
          ...item,
          status: "completed",
          completedAt: nowIso,
          updatedAt: nowIso,
        }),
        now,
      );
    }
    case "owned-work.cancel": {
      const found = findItem(items, command.itemId);
      if (Result.isFailure(found)) return Result.fail(found.failure);
      const { item, index } = found.success;
      if (!isOpen(item.status)) {
        return Result.fail(`Owned work item ${command.itemId} is already closed (${item.status}).`);
      }
      if (
        command.actorThreadId !== undefined &&
        command.actorThreadId !== item.createdByThreadId &&
        !actorOwns(item, command.actorThreadId)
      ) {
        return Result.fail(`Owned work item ${command.itemId} cannot be cancelled by this thread.`);
      }
      return withItems(
        thread,
        replaceAt(items, index, {
          ...item,
          status: "cancelled",
          completedAt: nowIso,
          updatedAt: nowIso,
        }),
        now,
      );
    }
  }
}
