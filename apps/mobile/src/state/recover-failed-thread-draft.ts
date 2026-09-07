import type { QueuedThreadMessage } from "./thread-outbox-model";
import { scopedThreadKey } from "../lib/scopedEntities";
import { restoredNewTaskDraftKey } from "./new-task-draft-key";
import {
  appendComposerDraftAttachments,
  clearComposerDraftContent,
  flushComposerDrafts,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
} from "./use-composer-drafts";

/** Move unsent setup edits into the restored task before reopening its editor. */
export async function recoverFailedThreadDraft(message: QueuedThreadMessage): Promise<void> {
  const sourceKey = scopedThreadKey(message.environmentId, message.threadId);
  const targetKey = restoredNewTaskDraftKey(message.messageId);
  const source = getComposerDraftSnapshot(sourceKey);
  if (source.text.length === 0 && source.attachments.length === 0) return;

  await mergeComposerDraftContent(targetKey, { text: source.text, attachments: [] });
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
