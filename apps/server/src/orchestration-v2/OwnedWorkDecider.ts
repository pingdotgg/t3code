import {
  appendOwnedWorkHistory,
  type OrchestrationV2ServerCommand,
  type OwnedWorkHistoryEntry,
  type OwnedWorkItem,
  type ProjectId,
  ownedWorkClosureError,
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
      | "owned-work.hold"
      | "owned-work.resume"
      | "owned-work.attention"
      | "owned-work.complete"
      | "owned-work.cancel";
  }
>;

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
  status === "on_hold" ||
  status === "needs_attention" ||
  status === "handed_off";

const isActiveOwnership = (status: OwnedWorkItem["status"]) =>
  status === "claimed" ||
  status === "in_progress" ||
  status === "on_hold" ||
  status === "needs_attention";

const actorOwns = (item: OwnedWorkItem, actorThreadId: string | undefined) => {
  if (actorThreadId === undefined) return true;
  if (item.claimedByThreadId === actorThreadId) return true;
  if (item.status === "assigned" && item.createdByThreadId === actorThreadId) return true;
  return false;
};

const history = (
  item: OwnedWorkItem,
  entry: Omit<OwnedWorkHistoryEntry, "at"> & { readonly at: string },
): ReadonlyArray<OwnedWorkHistoryEntry> => appendOwnedWorkHistory(item.history, entry);

/**
 * Applies an owned-work command to the project board. Complete requires a closure reason
 * (delivery, not acceptance). Hold/attention keep the item open with a resume path.
 */
export function decideOwnedWorkCommand(input: {
  readonly projectId: ProjectId;
  readonly items: ReadonlyArray<OwnedWorkItem>;
  readonly command: OwnedWorkCommand;
  readonly now: DateTime.Utc;
}): Result.Result<ReadonlyArray<OwnedWorkItem>, string> {
  const { projectId, items, command, now } = input;
  if (command.projectId !== projectId) {
    return Result.fail(
      `Owned work command project ${command.projectId} does not match ${projectId}.`,
    );
  }
  const nowIso = DateTime.formatIso(now);

  switch (command.type) {
    case "owned-work.assign": {
      if (items.some((item) => item.id === command.itemId)) {
        return Result.fail(`Owned work item ${command.itemId} already exists.`);
      }
      const createdByThreadId = command.createdByThreadId ?? command.threadId;
      const item: OwnedWorkItem = {
        id: command.itemId,
        projectId,
        title: command.title,
        description: command.description,
        status: "assigned",
        assigneeThreadId: command.assigneeThreadId ?? null,
        claimedByThreadId: null,
        progress: null,
        holdReason: null,
        attentionReason: null,
        handoffNote: null,
        closureReason: null,
        closureTarget: null,
        closureNote: null,
        history: [
          {
            at: nowIso,
            kind: "assigned",
            actorThreadId: createdByThreadId,
            note: null,
          },
        ],
        createdByThreadId,
        createdAt: nowIso,
        updatedAt: nowIso,
        claimedAt: null,
        completedAt: null,
      };
      return Result.succeed([...items, item]);
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
      return Result.succeed(
        replaceAt(items, index, {
          ...item,
          status: "claimed",
          claimedByThreadId: command.claimedByThreadId,
          claimedAt: nowIso,
          updatedAt: nowIso,
          history: history(item, {
            at: nowIso,
            kind: "claimed",
            actorThreadId: command.claimedByThreadId,
            note: null,
          }),
        }),
      );
    }
    case "owned-work.progress": {
      const found = findItem(items, command.itemId);
      if (Result.isFailure(found)) return Result.fail(found.failure);
      const { item, index } = found.success;
      if (!isActiveOwnership(item.status)) {
        return Result.fail(
          `Owned work item ${command.itemId} must be claimed before progress (${item.status}).`,
        );
      }
      if (!actorOwns(item, command.actorThreadId)) {
        return Result.fail(`Owned work item ${command.itemId} is owned by another thread.`);
      }
      return Result.succeed(
        replaceAt(items, index, {
          ...item,
          status: "in_progress",
          progress: command.progress,
          holdReason: null,
          attentionReason: null,
          updatedAt: nowIso,
          history: history(item, {
            at: nowIso,
            kind: "progress",
            actorThreadId: command.actorThreadId ?? item.claimedByThreadId,
            note: command.progress,
          }),
        }),
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
      return Result.succeed(
        replaceAt(items, index, {
          ...item,
          status: "handed_off",
          assigneeThreadId: command.toThreadId,
          claimedByThreadId: null,
          claimedAt: null,
          holdReason: null,
          attentionReason: null,
          handoffNote: command.note ?? item.handoffNote,
          updatedAt: nowIso,
          history: history(item, {
            at: nowIso,
            kind: "handoff",
            actorThreadId: command.actorThreadId ?? item.claimedByThreadId,
            note: command.note ?? null,
            toThreadId: command.toThreadId,
          }),
        }),
      );
    }
    case "owned-work.hold": {
      const found = findItem(items, command.itemId);
      if (Result.isFailure(found)) return Result.fail(found.failure);
      const { item, index } = found.success;
      if (!isActiveOwnership(item.status)) {
        return Result.fail(
          `Owned work item ${command.itemId} must be active before hold (${item.status}).`,
        );
      }
      if (!actorOwns(item, command.actorThreadId)) {
        return Result.fail(`Owned work item ${command.itemId} is owned by another thread.`);
      }
      return Result.succeed(
        replaceAt(items, index, {
          ...item,
          status: "on_hold",
          holdReason: command.reason,
          attentionReason: null,
          updatedAt: nowIso,
          history: history(item, {
            at: nowIso,
            kind: "hold",
            actorThreadId: command.actorThreadId ?? item.claimedByThreadId,
            note: command.reason,
          }),
        }),
      );
    }
    case "owned-work.resume": {
      const found = findItem(items, command.itemId);
      if (Result.isFailure(found)) return Result.fail(found.failure);
      const { item, index } = found.success;
      if (item.status !== "on_hold" && item.status !== "needs_attention") {
        return Result.fail(
          `Owned work item ${command.itemId} is not waiting to resume (${item.status}).`,
        );
      }
      if (!actorOwns(item, command.actorThreadId)) {
        return Result.fail(`Owned work item ${command.itemId} is owned by another thread.`);
      }
      return Result.succeed(
        replaceAt(items, index, {
          ...item,
          status: "in_progress",
          holdReason: null,
          attentionReason: null,
          updatedAt: nowIso,
          history: history(item, {
            at: nowIso,
            kind: "resume",
            actorThreadId: command.actorThreadId ?? item.claimedByThreadId,
            note: command.note ?? null,
          }),
        }),
      );
    }
    case "owned-work.attention": {
      const found = findItem(items, command.itemId);
      if (Result.isFailure(found)) return Result.fail(found.failure);
      const { item, index } = found.success;
      if (!isActiveOwnership(item.status) && item.status !== "handed_off") {
        return Result.fail(
          `Owned work item ${command.itemId} cannot need attention (${item.status}).`,
        );
      }
      if (!actorOwns(item, command.actorThreadId) && item.status !== "handed_off") {
        return Result.fail(`Owned work item ${command.itemId} is owned by another thread.`);
      }
      return Result.succeed(
        replaceAt(items, index, {
          ...item,
          status: "needs_attention",
          attentionReason: command.reason,
          holdReason: null,
          updatedAt: nowIso,
          history: history(item, {
            at: nowIso,
            kind: "attention",
            actorThreadId: command.actorThreadId ?? item.claimedByThreadId,
            note: command.reason,
          }),
        }),
      );
    }
    case "owned-work.complete": {
      const found = findItem(items, command.itemId);
      if (Result.isFailure(found)) return Result.fail(found.failure);
      const { item, index } = found.success;
      if (!isActiveOwnership(item.status)) {
        return Result.fail(
          `Owned work item ${command.itemId} must be claimed before complete (${item.status}).`,
        );
      }
      if (!actorOwns(item, command.actorThreadId)) {
        return Result.fail(`Owned work item ${command.itemId} is owned by another thread.`);
      }
      const closureError = ownedWorkClosureError({
        closureReason: command.closureReason,
        closureTarget: command.closureTarget,
      });
      if (closureError !== null) return Result.fail(closureError);
      const status = command.closureReason === "canceled" ? "cancelled" : "completed";
      return Result.succeed(
        replaceAt(items, index, {
          ...item,
          status,
          holdReason: null,
          attentionReason: null,
          closureReason: command.closureReason,
          closureTarget: command.closureTarget ?? null,
          closureNote: command.closureNote ?? null,
          completedAt: nowIso,
          updatedAt: nowIso,
          history: history(item, {
            at: nowIso,
            kind: status === "cancelled" ? "cancelled" : "completed",
            actorThreadId: command.actorThreadId ?? item.claimedByThreadId,
            note: command.closureNote ?? null,
            closureReason: command.closureReason,
          }),
        }),
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
      return Result.succeed(
        replaceAt(items, index, {
          ...item,
          status: "cancelled",
          holdReason: null,
          attentionReason: null,
          closureReason: "canceled",
          closureTarget: null,
          closureNote: command.closureNote ?? null,
          completedAt: nowIso,
          updatedAt: nowIso,
          history: history(item, {
            at: nowIso,
            kind: "cancelled",
            actorThreadId: command.actorThreadId ?? item.claimedByThreadId,
            note: command.closureNote ?? null,
            closureReason: "canceled",
          }),
        }),
      );
    }
  }
}
