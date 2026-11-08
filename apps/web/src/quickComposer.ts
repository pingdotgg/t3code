import type { DraftId } from "./composerDraftStore";
import { create } from "zustand";

/** The desktop Quick Composer window loads the app at this route; web and mobile never do. */
export const QUICK_COMPOSER_PATH = "/quick-composer";

// Desktop uses hash history, and the window is opened straight at this route.
export const isQuickComposerWindow = (): boolean =>
  typeof window !== "undefined" && window.location.hash.startsWith(`#${QUICK_COMPOSER_PATH}`);

/** A draft the main window should send as soon as its ChatView can, once. */
export const useQuickComposerAutoSendStore = create<{
  readonly draftId: DraftId | null;
  readonly request: (draftId: DraftId) => void;
  readonly clear: () => void;
}>()((set) => ({
  draftId: null,
  request: (draftId) => set({ draftId }),
  clear: () => set({ draftId: null }),
}));
