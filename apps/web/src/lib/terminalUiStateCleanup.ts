interface TerminalUiRetentionThread {
  key: string;
  deletedAt: string | null;
  archivedAt: string | null;
}

interface CollectActiveTerminalUiThreadKeysInput {
  snapshotThreads: readonly TerminalUiRetentionThread[];
  draftThreadKeys: Iterable<string>;
}

export function collectActiveTerminalUiThreadKeys(
  input: CollectActiveTerminalUiThreadKeysInput,
): Set<string> {
  const activeThreadKeys = new Set<string>();
  const snapshotThreadById = new Map(input.snapshotThreads.map((thread) => [thread.key, thread]));
  for (const thread of input.snapshotThreads) {
    if (thread.deletedAt !== null) continue;
    if (thread.archivedAt !== null) continue;
    activeThreadKeys.add(thread.key);
  }
  for (const draftThreadKey of input.draftThreadKeys) {
    const snapshotThread = snapshotThreadById.get(draftThreadKey);
    if (
      snapshotThread &&
      (snapshotThread.deletedAt !== null || snapshotThread.archivedAt !== null)
    ) {
      continue;
    }
    activeThreadKeys.add(draftThreadKey);
  }
  return activeThreadKeys;
}
