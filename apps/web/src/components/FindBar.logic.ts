export interface FindAnnouncement {
  readonly navigationId: number;
  readonly text: string;
  /** The label shows the outcome of `navigationId`: a count, a search or a failure. */
  readonly settled: boolean;
  /** "Searching…" or a failure: spoken, but a later count for the same navigation is too. */
  readonly provisional: boolean;
}

/**
 * What the find counter's live region says: the settled outcome of each
 * user search or step, once. Background refreshes during streaming keep the
 * navigation, so they stay silent. A new query passes through "Searching…",
 * so its count is spoken even when it equals the last one.
 */
export function nextFindAnnouncement(
  previous: FindAnnouncement | null,
  next: FindAnnouncement,
): FindAnnouncement {
  if (!next.settled) return previous ?? { ...next, text: "" };
  if (previous?.navigationId !== next.navigationId) return next;
  if (previous.settled && !previous.provisional) return previous;
  return previous.text === next.text ? previous : next;
}
