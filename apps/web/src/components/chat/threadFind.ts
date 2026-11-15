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
  readonly settled: boolean;
}

/**
 * What the find counter's live region says. It follows the label until the
 * result of the user's latest search or step settles, then holds still while
 * streamed content refreshes the count, so only user actions are spoken.
 */
export function nextThreadFindAnnouncement(
  previous: ThreadFindAnnouncement | null,
  next: ThreadFindAnnouncement,
): ThreadFindAnnouncement {
  if (!previous || previous.navigationId !== next.navigationId) return next;
  if (previous.settled) return previous;
  return previous.text === next.text && !next.settled ? previous : next;
}
