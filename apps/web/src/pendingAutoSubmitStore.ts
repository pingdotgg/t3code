/**
 * Transient signal store for "auto-submit on next mount".
 *
 * The splash composer (NoActiveThreadState) sets this flag for a draft when
 * the user submits, so the freshly-routed ChatView can fire onSend itself
 * instead of leaving the prompt sitting in the composer for the user to
 * press Enter again.
 *
 * Pure in-memory — never persisted. Reload should not trigger a phantom
 * submit, and the signal is one-shot (consumed exactly once).
 */
import { create } from "zustand";

interface PendingAutoSubmitStoreState {
  pendingDraftIds: ReadonlySet<string>;
  /** Mark a draft for auto-submit on the next ChatView mount. */
  request: (draftId: string) => void;
  /** Consume + clear the flag. Returns true iff one was pending. */
  consume: (draftId: string) => boolean;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

export const usePendingAutoSubmitStore = create<PendingAutoSubmitStoreState>((set, get) => ({
  pendingDraftIds: EMPTY_SET,

  request: (draftId) => {
    set((state) => {
      const next = new Set(state.pendingDraftIds);
      next.add(draftId);
      return { pendingDraftIds: next };
    });
  },

  consume: (draftId) => {
    const current = get().pendingDraftIds;
    if (!current.has(draftId)) return false;
    const next = new Set(current);
    next.delete(draftId);
    set({ pendingDraftIds: next });
    return true;
  },
}));
