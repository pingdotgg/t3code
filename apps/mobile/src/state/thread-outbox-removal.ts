import type { EnvironmentId } from "@t3tools/contracts";

import { appAtomRegistry } from "./atom-registry";
import { threadOutboxManager } from "./thread-outbox";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import {
  clearComposerDraft,
  composerDraftsAtom,
  flushComposerDrafts,
  scheduleUnusedComposerAttachmentCleanup,
  waitForComposerDraftsLoaded,
} from "./use-composer-drafts";

async function cleanUpRemovedMessages(
  removedMessages: ReadonlyArray<QueuedThreadMessage>,
): Promise<void> {
  const attachments = removedMessages.flatMap((message) => message.attachments);
  const removedCreations = removedMessages.filter((message) => message.creation !== undefined);
  if (removedCreations.length === 0) {
    scheduleUnusedComposerAttachmentCleanup(attachments);
    return;
  }

  try {
    await waitForComposerDraftsLoaded();
    const liveMessageIds = new Set(
      Object.values(appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom))
        .flat()
        .map((message) => message.messageId),
    );
    const drafts = appAtomRegistry.get(composerDraftsAtom);
    let clearedDraft = false;
    for (const message of removedCreations) {
      if (liveMessageIds.has(message.messageId)) {
        continue;
      }
      const draftKey = `pending-task:${message.messageId}`;
      const draft = drafts[draftKey];
      if (draft === undefined) {
        continue;
      }
      attachments.push(...draft.attachments);
      clearComposerDraft(draftKey, { deferAttachmentCleanup: true });
      clearedDraft = true;
    }
    if (clearedDraft) {
      await flushComposerDrafts();
    }
  } catch (error) {
    // The outbox removal is already durable. Keep the files and report the
    // secondary cleanup failure without changing the successful result.
    console.warn("[thread-outbox] failed to clean up removed pending task drafts", error);
    return;
  }

  scheduleUnusedComposerAttachmentCleanup(attachments);
}

/**
 * The only way a queued message leaves the outbox. Removal also releases the
 * message's local attachment files (via the reference-counting sweep, so a
 * file still referenced by a draft or another queued message survives).
 * Keeping release inside the removal call means no call site can forget it.
 *
 * `expectedRevision` (from `threadOutboxRevision`) and `canRemove` make the
 * removal a compare-and-set: when an edit was accepted or an editor takes the
 * message, it stays queued, nothing is released, and this returns false.
 */
export async function removeThreadOutboxMessage(
  message: QueuedThreadMessage,
  expectedRevision?: number,
  canRemove?: () => boolean,
): Promise<boolean> {
  const removed = await threadOutboxManager.remove(message, expectedRevision, canRemove);
  if (removed === null) {
    return false;
  }
  // The removed payload, not the caller's snapshot: an accepted update may
  // have added files the snapshot never saw.
  await cleanUpRemovedMessages([removed]);
  return true;
}

/** Removes every queued message of an environment and releases their files. */
export async function clearThreadOutboxEnvironment(environmentId: EnvironmentId): Promise<void> {
  // clearEnvironment loads and merges persisted messages itself and reports
  // what it actually removed, so the release set cannot miss messages a
  // failed earlier hydration would have hidden.
  const removed = await threadOutboxManager.clearEnvironment(environmentId);
  await cleanUpRemovedMessages(removed);
}
