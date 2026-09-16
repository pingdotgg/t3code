import type { DraftComposerAttachment } from "../lib/composerImages";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { threadEnvironment } from "./threads";
import { importQueuedMessageAttachment } from "../lib/composerContextClipboard";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import {
  confirmThreadOutboxMessageQueued,
  threadOutboxRevision,
  type QueuedThreadMessage,
} from "./thread-outbox";
import { removeThreadOutboxMessage } from "./thread-outbox-removal";
import {
  flushComposerDrafts,
  scheduleUnusedComposerAttachmentCleanup,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  undoComposerDraftMerge,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
} from "./use-composer-drafts";
import {
  dispatchingQueuedMessageIdAtom,
  editingQueuedMessageIdsAtom,
  holdEditingQueuedMessage,
  releaseEditingQueuedMessage,
} from "./use-thread-outbox";

/** Take delivery ownership before any await; the durable draft then takes ownership of the files. */
export async function editPendingThreadMessage(message: QueuedThreadMessage): Promise<boolean> {
  if (
    message.creation ||
    appAtomRegistry.get(dispatchingQueuedMessageIdAtom) === message.messageId ||
    appAtomRegistry.get(editingQueuedMessageIdsAtom)[message.messageId]
  ) {
    return false;
  }
  holdEditingQueuedMessage(message.messageId);
  const draftKey = scopedThreadKey(message.environmentId, message.threadId);
  let rollback: {
    snapshot: ReturnType<typeof getComposerDraftSnapshot>;
    merged: ReturnType<typeof getComposerDraftSnapshot>;
  } | null = null;
  const importedAttachments: DraftComposerAttachment[] = [];
  try {
    if (message.serverMessage) {
      const source = message.serverMessage;
      for (const attachment of source.attachments) {
        importedAttachments.push(
          await importQueuedMessageAttachment(attachment, message.environmentId),
        );
      }
      const attachments = importedAttachments;
      message = {
        ...message,
        attachments,
        context: source.context
          ? {
              ...source.context,
              records: source.context.records.map((record) => {
                if (!("attachmentId" in record)) return record;
                const index = source.attachments.findIndex(
                  (attachment) => attachment.id === record.attachmentId,
                );
                return attachments[index]
                  ? { ...record, attachmentId: attachments[index].id }
                  : record;
              }),
            }
          : undefined,
      };
    } else if (!(await confirmThreadOutboxMessageQueued(message))) return false;
    const revision = threadOutboxRevision(message.messageId);
    await waitForComposerDraftsLoaded();
    const snapshot = getComposerDraftSnapshot(draftKey);
    const attachmentIds = new Set(snapshot.attachments.map((attachment) => attachment.id));
    for (const attachment of message.attachments) attachmentIds.add(attachment.id);
    if (attachmentIds.size > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      throw new Error("Remove attachments from the composer before editing this message.");
    }
    try {
      await mergeComposerDraftContent(draftKey, message);
    } finally {
      rollback = { snapshot, merged: getComposerDraftSnapshot(draftKey) };
    }
    updateComposerDraftSettings(draftKey, {
      ...(message.modelSelection ? { modelSelection: message.modelSelection } : {}),
      ...(message.runtimeMode ? { runtimeMode: message.runtimeMode } : {}),
      ...(message.interactionMode ? { interactionMode: message.interactionMode } : {}),
    });
    rollback = { snapshot, merged: getComposerDraftSnapshot(draftKey) };
    await flushComposerDrafts();
    if (message.serverMessage) {
      const result = await runAtomCommand(appAtomRegistry, threadEnvironment.removeQueuedMessage, {
        environmentId: message.environmentId,
        input: { threadId: message.threadId, messageId: message.messageId },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    } else if (!(await removeThreadOutboxMessage(message, revision))) return false;
    rollback = null;
    return true;
  } finally {
    try {
      if (rollback) await undoComposerDraftMerge(draftKey, rollback.snapshot, rollback.merged);
    } finally {
      releaseEditingQueuedMessage(message.messageId);
      scheduleUnusedComposerAttachmentCleanup(importedAttachments);
    }
  }
}
