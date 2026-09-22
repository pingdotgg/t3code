import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import { type ComposerThreadTarget, DraftId, useComposerDraftStore } from "../composerDraftStore";
import { releaseDraftAttachments } from "./attachmentUploadQueue";

export function releaseComposerDraftUploads(target: ScopedThreadRef | DraftId): void {
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  if (draft) {
    releaseDraftAttachments([...draft.images, ...draft.files]);
  }
}

/**
 * Discards every composer record represented by the target, releasing each
 * record's uploads before clearing its draft references. A server thread can
 * have both a scoped composer record and matching draft-session records, so
 * deletion must sweep both key domains.
 */
export function discardComposerDraft(target: ScopedThreadRef | DraftId): void {
  const store = useComposerDraftStore.getState();
  const discardTargets: ComposerThreadTarget[] = [target];

  if (typeof target !== "string") {
    const directKey = scopedThreadKey(target);
    // Without its own record, the scoped target resolves to the first matching
    // session below. Clearing it in the same iteration makes that session's
    // later explicit target a no-op instead of a second attachment release.
    for (const [draftKey, session] of Object.entries(store.draftThreadsByThreadKey)) {
      if (
        draftKey !== directKey &&
        session.environmentId === target.environmentId &&
        session.threadId === target.threadId
      ) {
        discardTargets.push(DraftId.make(draftKey));
      }
    }
  }

  for (const discardTarget of discardTargets) {
    const draft = store.getComposerDraft(discardTarget);
    if (draft) {
      releaseDraftAttachments([...draft.images, ...draft.files]);
    }
    store.clearDraftThread(discardTarget);
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
