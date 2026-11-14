import type { EnvironmentId } from "@t3tools/contracts";
import { composerDraftEnvironmentId } from "../lib/composerAttachmentUploadQueue";
import {
  composerAttachmentFileReferenceKey,
  isComposerAttachmentFileRetained,
} from "../lib/composerAttachmentFiles";
import { registerComposerAttachmentUnusedHandler } from "../lib/composerAttachmentPreviewRetention";
import type { DraftComposerAttachment } from "../lib/composerImages";
import { appAtomRegistry } from "./atom-registry";
import { composerCloudDraftsAtom, composerDraftsAtom } from "./composer-drafts-model";
import { flushComposerDrafts, waitForComposerDraftsLoaded } from "./composer-drafts-persistence";
import { flushThreadOutbox, threadOutboxManager } from "./thread-outbox";

function signedOutAttachmentOwners() {
  return Object.values(appAtomRegistry.get(composerCloudDraftsAtom).signedOut).flatMap((saved) => [
    ...Object.values(saved.drafts),
    ...saved.queuedMessages,
  ]);
}

export function findLocalComposerClipboardAttachment(
  knownEnvironmentIds: Iterable<EnvironmentId>,
  environmentId: EnvironmentId,
  id: string,
): DraftComposerAttachment | undefined {
  const queuedMessages = Object.values(
    appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  ).flat();
  for (const [key, draft] of Object.entries(appAtomRegistry.get(composerDraftsAtom))) {
    if (
      composerDraftEnvironmentId(key, knownEnvironmentIds, queuedMessages, draft) !== environmentId
    )
      continue;
    const attachment = draft.attachments.find((entry) => entry.id === id);
    if (attachment) return attachment;
  }
  return queuedMessages
    .filter((message) => message.environmentId === environmentId)
    .flatMap((message) => message.attachments)
    .find((attachment) => attachment.id === id);
}

function isComposerAttachmentFileReferenced(fileUri: string): boolean {
  if (isComposerAttachmentFileRetained(fileUri)) {
    return true;
  }
  const referenceKey = composerAttachmentFileReferenceKey(fileUri);
  const drafts = Object.values(appAtomRegistry.get(composerDraftsAtom));
  const queuedMessages = Object.values(
    appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  ).flat();
  return [...drafts, ...queuedMessages, ...signedOutAttachmentOwners()].some((owner) =>
    owner.attachments.some(
      (attachment) =>
        attachment.fileUri !== undefined &&
        composerAttachmentFileReferenceKey(attachment.fileUri) === referenceKey,
    ),
  );
}

function isComposerAttachmentUploadReferenced(
  environmentId: EnvironmentId,
  attachmentId: string,
): boolean {
  const drafts = Object.values(appAtomRegistry.get(composerDraftsAtom));
  const queuedMessages = Object.values(
    appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  ).flat();
  return [...drafts, ...queuedMessages, ...signedOutAttachmentOwners()].some((owner) =>
    owner.attachments.some(
      (attachment) =>
        attachment.uploadEnvironmentId === environmentId &&
        attachment.uploadedAttachmentId === attachmentId,
    ),
  );
}

export async function releaseUnusedComposerAttachmentFiles(
  attachments: ReadonlyArray<DraftComposerAttachment>,
): Promise<void> {
  const candidates = new Set(
    attachments.flatMap((attachment) =>
      attachment.fileUri !== undefined ? [attachment.fileUri] : [],
    ),
  );
  const uploadCandidates = new Map<EnvironmentId, Set<string>>();
  for (const attachment of attachments) {
    if (
      attachment.uploadEnvironmentId === undefined ||
      attachment.uploadedAttachmentId === undefined
    ) {
      continue;
    }
    const ids = uploadCandidates.get(attachment.uploadEnvironmentId) ?? new Set<string>();
    ids.add(attachment.uploadedAttachmentId);
    uploadCandidates.set(attachment.uploadEnvironmentId, ids);
  }
  if (candidates.size === 0 && uploadCandidates.size === 0) {
    return;
  }

  // Hydrate before scanning references; cold-start atoms would otherwise mark owned files unused.
  await waitForComposerDraftsLoaded();
  await flushComposerDrafts();
  if (!(await threadOutboxManager.load())) {
    // Unreadable outbox stores may still own files; do not treat them as empty.
    return;
  }
  await flushThreadOutbox();

  const allFilesReferenced = [...candidates].every(isComposerAttachmentFileReferenced);
  const allUploadsReferenced = [...uploadCandidates].every(([environmentId, attachmentIds]) =>
    [...attachmentIds].every((attachmentId) =>
      isComposerAttachmentUploadReferenced(environmentId, attachmentId),
    ),
  );
  if (allFilesReferenced && allUploadsReferenced) {
    return;
  }

  let incomingShareFileUris: ReadonlySet<string>;
  try {
    const { loadIncomingShareDrafts } = await import("../features/sharing/incoming-share-storage");
    const incomingShares = await loadIncomingShareDrafts({ strict: true });
    incomingShareFileUris = new Set(
      incomingShares.flatMap((share) =>
        share.attachments.flatMap((attachment) =>
          attachment.fileUri !== undefined
            ? [composerAttachmentFileReferenceKey(attachment.fileUri)]
            : [],
        ),
      ),
    );
  } catch (error) {
    console.warn("[composer-attachments] could not verify incoming share ownership", error);
    return;
  }

  const { removePersistedComposerAttachmentFile } = await import("../lib/composerImages");
  for (const fileUri of candidates) {
    // Re-check immediately before deletion; restores or edits can acquire ownership after scanning.
    if (
      isComposerAttachmentFileReferenced(fileUri) ||
      incomingShareFileUris.has(composerAttachmentFileReferenceKey(fileUri))
    ) {
      continue;
    }
    await removePersistedComposerAttachmentFile(fileUri);
  }

  if (uploadCandidates.size > 0) {
    const { releasePendingAttachmentUploads } = await import("../lib/attachmentUpload");
    for (const [environmentId, attachmentIds] of uploadCandidates) {
      for (const attachmentId of attachmentIds) {
        if (isComposerAttachmentUploadReferenced(environmentId, attachmentId)) {
          continue;
        }
        try {
          await releasePendingAttachmentUploads(environmentId, [attachmentId]);
        } catch (error) {
          // The server expires pending uploads; local discard must survive disconnection or deletion failure.
          console.warn("[composer-attachments] could not remove pending upload", {
            environmentId,
            attachmentId,
            error,
          });
        }
      }
    }
  }
}

export function scheduleUnusedComposerAttachmentCleanup(
  attachments: ReadonlyArray<DraftComposerAttachment>,
): void {
  if (
    !attachments.some(
      (attachment) =>
        attachment.fileUri !== undefined || attachment.uploadedAttachmentId !== undefined,
    )
  ) {
    return;
  }
  void releaseUnusedComposerAttachmentFiles(attachments).catch((error) => {
    console.warn("[composer-attachments] could not remove unused files", error);
  });
}

registerComposerAttachmentUnusedHandler((attachment) => {
  scheduleUnusedComposerAttachmentCleanup([attachment]);
});
