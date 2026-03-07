import type { ThreadId } from "@t3tools/contracts";

export interface ThreadScrollSnapshot {
  readonly scrollTop: number;
  readonly shouldAutoScroll: boolean;
}

const threadScrollSnapshots = new Map<ThreadId, ThreadScrollSnapshot>();

export function readThreadScrollSnapshot(threadId: ThreadId): ThreadScrollSnapshot | null {
  return threadScrollSnapshots.get(threadId) ?? null;
}

export function writeThreadScrollSnapshot(
  threadId: ThreadId,
  snapshot: ThreadScrollSnapshot,
): void {
  threadScrollSnapshots.set(threadId, snapshot);
}
