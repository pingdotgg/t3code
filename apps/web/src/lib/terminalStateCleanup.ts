interface TerminalRetentionThread {
  key: string;
  deletedAt: string | null;
  archivedAt: string | null;
}

interface CollectActiveTerminalThreadIdsInput {
  snapshotThreads: readonly TerminalRetentionThread[];
  draftThreadKeys: Iterable<string>;
}

export function collectActiveTerminalThreadIds(
  input: CollectActiveTerminalThreadIdsInput,
): Set<string> {
  const activeThreadIds = new Set<string>();
  const snapshotThreadById = new Map(input.snapshotThreads.map((thread) => [thread.key, thread]));
  for (const thread of input.snapshotThreads) {
    if (thread.deletedAt !== null) continue;
    if (thread.archivedAt !== null) continue;
    activeThreadIds.add(thread.key);
  }
  for (const draftThreadKey of input.draftThreadKeys) {
    const snapshotThread = snapshotThreadById.get(draftThreadKey);
    if (
      snapshotThread &&
      (snapshotThread.deletedAt !== null || snapshotThread.archivedAt !== null)
    ) {
      continue;
    }
    activeThreadIds.add(draftThreadKey);
  }
  return activeThreadIds;
}
