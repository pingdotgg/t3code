import { appAtomRegistry } from "./atom-registry";
import { threadOutboxManager } from "./thread-outbox";
import {
  dispatchingQueuedMessageIdAtom,
  editingQueuedMessageIdsAtom,
  holdEditingQueuedMessage,
  releaseEditingQueuedMessage,
} from "./use-thread-outbox";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import { scopedThreadKey } from "../lib/scopedEntities";
import { pendingTaskDraftKey, restoredNewTaskDraftKey } from "./new-task-draft-key";
import {
  appendComposerDraftAttachments,
  clearComposerDraftContent,
  flushComposerDrafts,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  isComposerDraftEmpty,
  setComposerDraftText,
  setComposerDraftContext,
  replaceComposerDraftAttachments,
  updateComposerDraftSettings,
} from "./use-composer-drafts";

/** Move unsent setup edits into the restored task before reopening its editor. */
export async function recoverFailedThreadDraft(
  message: QueuedThreadMessage,
  options?: { readonly retainedInOutbox: boolean },
): Promise<void> {
  const sourceKey = scopedThreadKey(message.environmentId, message.threadId);
  const targetKey = options?.retainedInOutbox
    ? pendingTaskDraftKey(message.messageId)
    : restoredNewTaskDraftKey(message.messageId);
  if (
    options?.retainedInOutbox &&
    message.creation &&
    isComposerDraftEmpty(getComposerDraftSnapshot(targetKey))
  ) {
    setComposerDraftText(targetKey, message.text);
    setComposerDraftContext(targetKey, message.context);
    replaceComposerDraftAttachments(targetKey, message.attachments);
    updateComposerDraftSettings(targetKey, {
      taskId: message.creation.taskId ?? null,
      modelSelection: message.modelSelection,
      runtimeMode: message.runtimeMode,
      interactionMode: message.interactionMode,
      workspaceSelection: {
        mode: message.creation.workspaceMode,
        branch: message.creation.branch,
        worktreePath: message.creation.worktreePath,
        startFromOrigin: message.creation.startFromOrigin ?? false,
      },
    });
    await flushComposerDrafts();
  }
  const source = getComposerDraftSnapshot(sourceKey);
  if (source.text.length === 0 && source.attachments.length === 0) return;

  await mergeComposerDraftContent(targetKey, {
    text: source.text,
    context: source.context,
    attachments: [],
  });
  const existingIds = new Set(
    getComposerDraftSnapshot(targetKey).attachments.map((attachment) => attachment.id),
  );
  appendComposerDraftAttachments(
    targetKey,
    source.attachments.filter((attachment) => !existingIds.has(attachment.id)),
    { allowOverflow: true },
  );
  // Recovery may exceed the send cap. Preserve every file and let the editor
  // ask the user to remove extras; never discard them during a failed send.
  await flushComposerDrafts();
  clearComposerDraftContent(sourceKey);
}

/** Reserve delivery synchronously, then hand the reservation to the pending editor. */
export async function recoverRetainedQueuedThreadDraft(
  message: QueuedThreadMessage,
  openEditor: (current: QueuedThreadMessage) => void,
): Promise<void> {
  if (appAtomRegistry.get(dispatchingQueuedMessageIdAtom) === message.messageId) {
    throw new Error("This queued thread is being delivered. Try again after delivery finishes.");
  }
  if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[message.messageId]) {
    throw new Error("This queued thread is already being edited.");
  }
  const current = Object.values(
    appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  )
    .flat()
    .find(
      (candidate) =>
        candidate.messageId === message.messageId &&
        candidate.environmentId === message.environmentId &&
        candidate.threadId === message.threadId,
    );
  if (!current?.creation) throw new Error("This thread is no longer queued.");
  holdEditingQueuedMessage(current.messageId);
  try {
    await recoverFailedThreadDraft(current, { retainedInOutbox: true });
    openEditor(current);
    // beginEditingPendingTask adopts the same reservation; its save/cancel paths release it.
  } catch (error) {
    releaseEditingQueuedMessage(current.messageId);
    throw error;
  }
}
