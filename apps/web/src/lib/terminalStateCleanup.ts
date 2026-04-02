import type { ThreadId } from "@t3tools/contracts";

interface TerminalRetentionThread {
  id: ThreadId;
  deletedAt: string | null;
  archivedAt: string | null;
}

interface CollectActiveTerminalThreadIdsInput {
  snapshotThreads: readonly TerminalRetentionThread[];
  draftThreadIds: Iterable<ThreadId>;
}

export function collectActiveTerminalThreadIds(
  input: CollectActiveTerminalThreadIdsInput,
): Set<ThreadId> {
  const activeThreadIds = new Set<ThreadId>();
  const snapshotThreadById = new Map(input.snapshotThreads.map((thread) => [thread.id, thread]));
  for (const thread of input.snapshotThreads) {
    if (thread.deletedAt !== null) continue;
    if (thread.archivedAt !== null) continue;
    activeThreadIds.add(thread.id);
  }
  for (const draftThreadId of input.draftThreadIds) {
    const snapshotThread = snapshotThreadById.get(draftThreadId);
    if (
      snapshotThread &&
      (snapshotThread.deletedAt !== null || snapshotThread.archivedAt !== null)
    ) {
      continue;
    }
    activeThreadIds.add(draftThreadId);
  }
  return activeThreadIds;
}
