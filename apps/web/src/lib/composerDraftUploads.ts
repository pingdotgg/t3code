import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { releaseAttachmentUploads } from "./attachmentUploadQueue";

export function releaseComposerDraftUploads(target: ScopedThreadRef | DraftId): void {
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  if (draft) {
    releaseAttachmentUploads(draft.images);
  }
}

export function releaseProjectDraftUploads(projectRef: ScopedProjectRef): void {
  const store = useComposerDraftStore.getState();
  for (const [draftKey, session] of Object.entries(store.draftThreadsByThreadKey)) {
    if (
      session.environmentId === projectRef.environmentId &&
      session.projectId === projectRef.projectId
    ) {
      releaseAttachmentUploads(store.draftsByThreadKey[draftKey]?.images ?? []);
    }
  }
}
