import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import {
  type ComposerThreadTarget,
  composerDraftHasUserContent,
  resolveComposerDraftKey,
  useComposerDraftStore,
} from "../composerDraftStore";
import { showThreadUndoNotice } from "../hooks/showThreadUndoNotice";
import * as ThreadUndo from "../hooks/threadUndo";
import { releaseDraftAttachments } from "./attachmentUploadQueue";

/**
 * Discards a draft's unsent content behind the sidebar undo notice. A new-thread
 * draft (DraftId) loses its whole session; a thread draft only loses its
 * composer content. Uploads are released once the undo window closes.
 */
export function discardComposerDraft(target: ComposerThreadTarget): void {
  const store = useComposerDraftStore.getState();
  const key = resolveComposerDraftKey(store, target);
  const draft = key === null ? undefined : store.draftsByThreadKey[key];
  if (key === null || !draft) return;
  const session = store.draftThreadsByThreadKey[key];
  const logicalProjectKeys = Object.entries(store.logicalProjectDraftThreadKeyByLogicalProjectKey)
    .filter(([, draftKey]) => draftKey === key)
    .map(([logicalProjectKey]) => logicalProjectKey);
  const discardsSession = typeof target === "string";

  const claim = ThreadUndo.begin("discard", key);
  if (discardsSession) {
    store.clearDraftThread(target);
  } else {
    store.clearComposerContent(target);
  }

  showThreadUndoNotice({
    action: "Discarded",
    claim,
    failureTitle: "Failed to restore draft",
    undo: async () => {
      const current = useComposerDraftStore.getState().draftsByThreadKey[key];
      if (current && composerDraftHasUserContent(current)) {
        releaseDraftAttachments([...draft.images, ...draft.files]);
        return AsyncResult.failure(Cause.fail(new Error("The draft has new content.")));
      }
      useComposerDraftStore.setState((state) => {
        const logicalProjectDraftThreadKeyByLogicalProjectKey = {
          ...state.logicalProjectDraftThreadKeyByLogicalProjectKey,
        };
        for (const logicalProjectKey of logicalProjectKeys) {
          logicalProjectDraftThreadKeyByLogicalProjectKey[logicalProjectKey] ??= key;
        }
        return {
          draftsByThreadKey: {
            ...state.draftsByThreadKey,
            // Removing a draft session revokes its image previews.
            [key]: discardsSession
              ? {
                  ...draft,
                  images: draft.images.map((image) =>
                    image.previewUrl.startsWith("blob:")
                      ? { ...image, previewUrl: URL.createObjectURL(image.file) }
                      : image,
                  ),
                }
              : draft,
          },
          draftThreadsByThreadKey: session
            ? { ...state.draftThreadsByThreadKey, [key]: session }
            : state.draftThreadsByThreadKey,
          logicalProjectDraftThreadKeyByLogicalProjectKey,
        };
      });
      return AsyncResult.success(undefined);
    },
    commit: () => releaseDraftAttachments([...draft.images, ...draft.files]),
  });
}
