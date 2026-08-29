import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { releaseDraftAttachments } from "./attachmentUploadQueue";

export function releaseComposerDraftUploads(target: ScopedThreadRef | DraftId): void {
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  if (draft) {
    releaseDraftAttachments([...draft.images, ...draft.files]);
  }
}

/**
 * Releases every upload a deleted project's drafts still hold. Draft-thread
 * sessions carry their project ref, but drafts on the project's real threads
 * live in `draftsByThreadKey` under scoped thread keys with no project in the
 * key, so the caller passes the project's thread refs alongside.
 */
export function releaseProjectDraftUploads(
  projectRef: ScopedProjectRef,
  projectThreadRefs: ReadonlyArray<ScopedThreadRef> = [],
): void {
  const store = useComposerDraftStore.getState();
  for (const [draftKey, session] of Object.entries(store.draftThreadsByThreadKey)) {
    if (
      session.environmentId === projectRef.environmentId &&
      session.projectId === projectRef.projectId
    ) {
      const draft = store.draftsByThreadKey[draftKey];
      releaseDraftAttachments(draft ? [...draft.images, ...draft.files] : []);
    }
  }
  for (const threadRef of projectThreadRefs) {
    const draft = store.draftsByThreadKey[scopedThreadKey(threadRef)];
    if (draft) {
      releaseDraftAttachments([...draft.images, ...draft.files]);
    }
  }
}
