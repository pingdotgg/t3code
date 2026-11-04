/**
 * A picker's unsent choices, keyed by candidate: true to turn on, false to turn off. Keys the
 * user has not touched follow the host, so a refresh while the picker is open still shows.
 */
export type SelectionDraft = ReadonlyMap<string, boolean>;

export interface SelectionCandidate {
  readonly key: string;
  readonly selected: boolean;
}

export const isDraftSelected = (draft: SelectionDraft, candidate: SelectionCandidate) =>
  draft.get(candidate.key) ?? candidate.selected;

/** With `single`, turning one on turns the rest off, as a host that keeps one reviewer would. */
export function toggleDraft(
  draft: SelectionDraft,
  candidates: ReadonlyArray<SelectionCandidate>,
  toggled: SelectionCandidate,
  single: boolean,
): SelectionDraft {
  const next = new Map(draft);
  const selected = !isDraftSelected(draft, toggled);
  if (selected && single) {
    for (const candidate of candidates) {
      if (candidate.key !== toggled.key && isDraftSelected(next, candidate)) {
        next.set(candidate.key, false);
      }
    }
  }
  next.set(toggled.key, selected);
  for (const candidate of candidates) {
    if (next.get(candidate.key) === candidate.selected) next.delete(candidate.key);
  }
  return next;
}

/** What to send on close, against the host's latest state rather than the state at open. */
export function draftChanges<C extends SelectionCandidate>(
  draft: SelectionDraft,
  candidates: ReadonlyArray<C>,
) {
  const add: Array<C> = [];
  const remove: Array<C> = [];
  for (const candidate of candidates) {
    const wanted = draft.get(candidate.key);
    if (wanted === undefined || wanted === candidate.selected) continue;
    (wanted ? add : remove).push(candidate);
  }
  return { add, remove };
}
