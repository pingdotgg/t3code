import type { OrchestrationV2SearchThreadInput, RunId } from "@t3tools/contracts";

export type ThreadFindStart = NonNullable<OrchestrationV2SearchThreadInput["start"]>;
export type ThreadFindPositionReader = (query: string) => ThreadFindStart | undefined;

export interface ThreadFindMatch {
  readonly entryId: string;
  readonly runId: RunId | null;
  readonly occurrence: number;
}

function clampThreadFindIndex(index: number, total: number): number {
  if (total <= 0 || !Number.isFinite(index) || index < 0) return 0;
  return Math.min(Math.trunc(index), total - 1);
}

export function stepThreadFindIndex(index: number, total: number, delta: number): number {
  if (total <= 0) return 0;
  const clamped = clampThreadFindIndex(index, total);
  return (((clamped + delta) % total) + total) % total;
}

export function formatThreadFindCount(index: number, total: number): string {
  return total <= 0 ? "0/0" : `${clampThreadFindIndex(index, total) + 1}/${total}`;
}

export interface ThreadFindAnnouncement {
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
export function nextThreadFindAnnouncement(
  previous: ThreadFindAnnouncement | null,
  next: ThreadFindAnnouncement,
): ThreadFindAnnouncement {
  if (!next.settled) return previous ?? { ...next, text: "" };
  if (previous?.navigationId !== next.navigationId) return next;
  if (previous.settled && !previous.provisional) return previous;
  return previous.text === next.text ? previous : next;
}
