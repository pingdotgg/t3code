import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ComposerDraftStoreState, DraftThreadState } from "./draftTypes";
import { COMPOSER_DRAFT_STORAGE_KEY, COMPOSER_DRAFT_STORAGE_VERSION } from "./draftTypes";
import {
  composerPersistStorage,
  type ComposerPersistState,
  migratePersistedComposerDraftStoreState,
  normalizeCurrentPersistedComposerDraftStoreState,
} from "./persistence";
import { toHydratedDraftThreadState, toHydratedThreadDraft } from "./attachmentHydration";
import { createDraftSessionSlice } from "./createDraftSessionSlice";
import { createComposerModelSlice } from "./createComposerModelSlice";
import { createComposerAttachmentSlice } from "./createComposerAttachmentSlice";
import { createComposerContextSlice } from "./createComposerContextSlice";

export const composerDraftStore = create<ComposerDraftStoreState>()(
  persist(
    (setBase, get) => {
      const set = setBase;

      return {
        ...createInitialStoreState(),
        ...createDraftSessionSlice(set, get),
        ...createComposerModelSlice(set, get),
        ...createComposerAttachmentSlice(set, get),
        ...createComposerContextSlice(set, get),
      };
    },
    {
      name: COMPOSER_DRAFT_STORAGE_KEY,
      version: COMPOSER_DRAFT_STORAGE_VERSION,
      storage: composerPersistStorage,
      migrate: migratePersistedComposerDraftStoreState,
      partialize: (state): ComposerPersistState => ({ capturedState: state }),
      merge: (persistedState, currentState) => {
        const normalizedPersisted =
          normalizeCurrentPersistedComposerDraftStoreState(persistedState);
        const draftsByThreadKey = Object.fromEntries(
          Object.entries(normalizedPersisted.draftsByThreadKey).map(([threadKey, draft]) => [
            threadKey,
            toHydratedThreadDraft(draft),
          ]),
        );
        const draftThreadsByThreadKey = Object.fromEntries(
          Object.entries(normalizedPersisted.draftThreadsByThreadKey).map(
            ([threadKey, draftThread]) => [threadKey, toHydratedDraftThreadState(draftThread)],
          ),
        ) as Record<string, DraftThreadState>;
        return {
          ...currentState,
          draftsByThreadKey,
          draftThreadsByThreadKey,
          logicalProjectDraftThreadKeyByLogicalProjectKey:
            normalizedPersisted.logicalProjectDraftThreadKeyByLogicalProjectKey,
          stickyModelSelectionByProvider: normalizedPersisted.stickyModelSelectionByProvider ?? {},
          stickyOptionsByModelByProvider: normalizedPersisted.stickyOptionsByModelByProvider ?? {},
          stickyActiveProvider: normalizedPersisted.stickyActiveProvider ?? null,
        };
      },
    },
  ),
);

export const useComposerDraftStore = composerDraftStore;

/** Fields the store owns directly; the remaining actions come from the action slices. */
function createInitialStoreState(): Pick<
  ComposerDraftStoreState,
  | "draftsByThreadKey"
  | "draftThreadsByThreadKey"
  | "logicalProjectDraftThreadKeyByLogicalProjectKey"
  | "backgroundSubmissionThreadKeys"
  | "promotedDraftRedirects"
  | "rewindingThreadKeys"
  | "stickyModelSelectionByProvider"
  | "stickyOptionsByModelByProvider"
  | "stickyActiveProvider"
> {
  return {
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    backgroundSubmissionThreadKeys: {},
    promotedDraftRedirects: {},
    rewindingThreadKeys: new Set<string>(),
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  };
}
