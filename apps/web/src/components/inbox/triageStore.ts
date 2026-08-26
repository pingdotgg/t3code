/**
 * The triage pass: which reports it covers, in what order, and which one the
 * reader is on. Held outside the page so a trip into a report's conversation
 * and back lands the reader in the queue they were working, rather than
 * dropping them at the top of the list.
 *
 * The deck is a snapshot, not a live view. A pass is a walk someone is making
 * right now, and the reports list refetches underneath it — on a stale mount,
 * on every archive, on the refresh button. If membership and order followed
 * the server, a refetch could reorder the deck and leave the reader ruling on
 * a report they never chose. So the ids are captured when the pass begins and
 * do not move; what each id resolves to stays live, so a report resolved
 * somewhere else shows its new verdict when the reader reaches it.
 *
 * Reports that arrive mid-pass are counted rather than spliced in. The reader
 * picks them up when they want them.
 *
 * Session-scoped on purpose: a pass is not a preference worth persisting.
 */
import { create } from "zustand";

interface TriageStore {
  readonly active: boolean;
  /** Report ids in the order the pass captured them. */
  readonly deckIds: ReadonlyArray<string>;
  /** The report under the cursor. An id, never a position: nothing the
   *  reports list does can move the reader off the report they are reading. */
  readonly cursorId: string | null;
  /** Reports ruled on during this pass. They leave the deck and stay gone.
   *  Scoped to the pass, so it needs no reconciling with the server. */
  readonly ruled: ReadonlySet<string>;
  /** Starts a pass over these reports, in this order. */
  readonly begin: (deckIds: ReadonlyArray<string>) => void;
  readonly end: () => void;
  readonly setCursor: (reportId: string | null) => void;
  /** Adds reports that arrived after the pass began, at the end of the deck. */
  readonly pickUp: (reportIds: ReadonlyArray<string>) => void;
  readonly rule: (reportId: string) => void;
  /** Puts a report back when the decision that removed it did not land. */
  readonly unrule: (reportId: string) => void;
}

const NONE: ReadonlySet<string> = new Set();

export const useTriageStore = create<TriageStore>((set) => ({
  active: false,
  deckIds: [],
  cursorId: null,
  ruled: NONE,
  begin: (deckIds) =>
    set({ active: true, deckIds: [...deckIds], cursorId: deckIds[0] ?? null, ruled: NONE }),
  end: () => set({ active: false, deckIds: [], cursorId: null, ruled: NONE }),
  setCursor: (cursorId) => set({ cursorId }),
  pickUp: (reportIds) =>
    set((state) => {
      const held = new Set(state.deckIds);
      const added = reportIds.filter((id) => !held.has(id));
      return added.length === 0 ? state : { ...state, deckIds: [...state.deckIds, ...added] };
    }),
  rule: (reportId) => set((state) => ({ ...state, ruled: new Set(state.ruled).add(reportId) })),
  unrule: (reportId) =>
    set((state) => {
      if (!state.ruled.has(reportId)) return state;
      const next = new Set(state.ruled);
      next.delete(reportId);
      return { ...state, ruled: next };
    }),
}));
