import type { FileBackedComposerAttachment } from "./composerImages";
import { retainComposerAttachmentFile } from "./composerAttachmentFiles";

/**
 * Preview retention for saved composer attachment copies.
 *
 * The durable owners of an attachment file (composer drafts, queued outbox
 * messages) live in state, so this module cannot reach the ownership-cleanup
 * sweep directly. Composer draft state registers the owner-side cleanup hook
 * at module load; until then a release has nothing to retry, because no draft
 * store has loaded yet and there is nothing to clean.
 */
type UnusedAttachmentHandler = (attachment: FileBackedComposerAttachment) => void;

let onAttachmentUnused: UnusedAttachmentHandler | null = null;

export function registerComposerAttachmentUnusedHandler(handler: UnusedAttachmentHandler): void {
  onAttachmentUnused = handler;
}

/** Keeps a native preview or upload readable until it finishes, then retries ownership cleanup. */
export function retainComposerAttachmentFileForPreview(
  attachment: FileBackedComposerAttachment,
): () => void {
  return retainComposerAttachmentFile(attachment.fileUri, () => {
    onAttachmentUnused?.(attachment);
  });
}
