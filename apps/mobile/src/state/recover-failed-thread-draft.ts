import type { QueuedThreadMessage } from "./thread-outbox-model";
import type { DraftComposerAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { abortComposerDraftOperations } from "./composerDraftOperations";
import { restoredNewTaskDraftKey } from "./new-task-draft-key";
import {
  appendComposerDraftAttachments,
  clearComposerDraftContent,
  flushComposerDrafts,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
} from "./use-composer-drafts";

export async function recoverFailedThreadDraft(message: QueuedThreadMessage): Promise<void> {
  const sourceKey = scopedThreadKey(message.environmentId, message.threadId);
  const targetKey = restoredNewTaskDraftKey(message.messageId);
  const source = getComposerDraftSnapshot(sourceKey);
  if (source.text.length === 0 && source.attachments.length === 0) {
    abortComposerDraftOperations(sourceKey);
    return;
  }

  await mergeComposerDraftContent(targetKey, {
    text: source.text,
    context: source.context,
    attachments: [],
  });
  // Recovery may exceed caps; preserve every file and leave trimming to the editor.
  appendComposerDraftAttachments(targetKey, attachmentsMissingFrom(targetKey, source.attachments), {
    restore: true,
  });
  await flushComposerDrafts();
  abortComposerDraftOperations(sourceKey);
  // A paste still preparing can land in the source during the saves; move it with its reference.
  const sourceIds = new Set(source.attachments.map((attachment) => attachment.id));
  appendComposerDraftAttachments(
    targetKey,
    attachmentsMissingFrom(
      targetKey,
      getComposerDraftSnapshot(sourceKey).attachments.filter(
        (attachment) => !sourceIds.has(attachment.id),
      ),
    ),
    { restore: true, appendReference: true },
  );
  clearComposerDraftContent(sourceKey);
}

function attachmentsMissingFrom(
  draftKey: string,
  attachments: ReadonlyArray<DraftComposerAttachment>,
) {
  const existingIds = new Set(
    getComposerDraftSnapshot(draftKey).attachments.map((attachment) => attachment.id),
  );
  return attachments.filter((attachment) => !existingIds.has(attachment.id));
}
