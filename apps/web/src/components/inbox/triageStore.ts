/**
 * Whether the inbox is in triage. Held outside the page so a trip into a
 * report's conversation and back lands the reader in the queue they were
 * working, rather than dropping them at the top of the list.
 *
 * Session-scoped on purpose: triage is a pass someone is making right now,
 * not a preference worth persisting.
 */
import { create } from "zustand";

interface TriageStore {
  readonly active: boolean;
  readonly setActive: (active: boolean) => void;
}

export const useTriageStore = create<TriageStore>((set) => ({
  active: false,
  setActive: (active) => set({ active }),
}));
