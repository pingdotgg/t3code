import type { ContextMenuItem } from "@t3tools/contracts";
import type { SidebarThreadSummary } from "../types";

export function shouldRenderSidebarArchiveAll(input: {
  archivableCount: number;
  isArchiving: boolean;
}): boolean {
  return input.archivableCount > 0 || input.isArchiving;
}

export function formatArchiveSkippedDescription(skippedCount: number): string {
  return skippedCount === 1
    ? "1 thread was no longer eligible for this archive action and was skipped."
    : `${skippedCount} threads were no longer eligible for this archive action and were skipped.`;
}

export function buildMultiSelectThreadContextMenuItems(input: {
  count: number;
  hasArchiveBlockedThread: boolean;
}): readonly ContextMenuItem<"mark-unread" | "archive" | "delete">[] {
  return [
    { id: "mark-unread", label: `Mark unread (${input.count})` },
    {
      id: "archive",
      label: `Archive (${input.count})`,
      disabled: input.hasArchiveBlockedThread,
    },
    { id: "delete", label: `Delete (${input.count})`, destructive: true },
  ];
}

export async function archiveSelectedThreadEntries<
  TEntry extends { readonly threadKey: string },
  TResult extends { readonly _tag: "Success" | "Failure" },
>(input: {
  entries: readonly TEntry[];
  archive: (entry: TEntry, onArchived: () => void) => Promise<TResult>;
  canArchive?: (entry: TEntry) => boolean;
  onArchived?: (entry: TEntry) => void;
  onSkipped?: (entry: TEntry) => void;
}): Promise<{
  archivedThreadKeys: readonly string[];
  skippedThreadKeys: readonly string[];
  mutationFailure: Extract<TResult, { readonly _tag: "Failure" }> | null;
  followupFailures: readonly Extract<TResult, { readonly _tag: "Failure" }>[];
}> {
  const archivedThreadKeys: string[] = [];
  const skippedThreadKeys: string[] = [];
  const followupFailures: Extract<TResult, { readonly _tag: "Failure" }>[] = [];

  for (const entry of input.entries) {
    if (input.canArchive && !input.canArchive(entry)) {
      skippedThreadKeys.push(entry.threadKey);
      input.onSkipped?.(entry);
      continue;
    }
    let didArchive = false;
    const result = await input.archive(entry, () => {
      if (didArchive) return;
      didArchive = true;
      input.onArchived?.(entry);
    });
    if (didArchive || result._tag === "Success") {
      archivedThreadKeys.push(entry.threadKey);
    }
    if (result._tag === "Success") continue;
    const failure = result as Extract<TResult, { readonly _tag: "Failure" }>;
    if (didArchive) {
      followupFailures.push(failure);
      continue;
    }
    return { archivedThreadKeys, skippedThreadKeys, mutationFailure: failure, followupFailures };
  }

  return { archivedThreadKeys, skippedThreadKeys, mutationFailure: null, followupFailures };
}

export function getCompletedArchiveThreadKeys(input: {
  archivedThreadKeys: readonly string[];
  skippedThreadKeys: readonly string[];
}): readonly string[] {
  return [...input.archivedThreadKeys, ...input.skippedThreadKeys];
}

const sharedThreadArchiveReservations = new Map<string, Promise<ReadonlySet<string>>>();

export async function withCoordinatedThreadArchiveEntries<
  TEntry extends { readonly threadKey: string },
>(input: {
  entries: readonly TEntry[];
  reservations?: Map<string, Promise<ReadonlySet<string>>>;
  run: (
    entries: readonly TEntry[],
    onCompleted: (threadKey: string) => void,
  ) => Promise<readonly string[]>;
}): Promise<readonly string[]> {
  const reservations = input.reservations ?? sharedThreadArchiveReservations;
  const uniqueEntries: TEntry[] = [];
  const uniqueThreadKeys = new Set<string>();
  for (const entry of input.entries) {
    if (uniqueThreadKeys.has(entry.threadKey)) continue;
    uniqueThreadKeys.add(entry.threadKey);
    uniqueEntries.push(entry);
  }
  let resolveReservation: (completedThreadKeys: ReadonlySet<string>) => void = () => undefined;
  const reservation = new Promise<ReadonlySet<string>>((resolve) => {
    resolveReservation = resolve;
  });
  const ownedThreadKeys = new Set<string>();
  const completedThreadKeys = new Set<string>();
  let pendingEntries = uniqueEntries;

  try {
    while (pendingEntries.length > 0) {
      const activeReservations = new Set<Promise<ReadonlySet<string>>>();
      for (const entry of pendingEntries) {
        const activeReservation = reservations.get(entry.threadKey);
        if (activeReservation && activeReservation !== reservation) {
          activeReservations.add(activeReservation);
          continue;
        }
        reservations.set(entry.threadKey, reservation);
        ownedThreadKeys.add(entry.threadKey);
      }
      if (activeReservations.size === 0) break;

      const completedByOwners = new Set(
        (await Promise.all(activeReservations)).flatMap((threadKeys) => [...threadKeys]),
      );
      pendingEntries = pendingEntries.filter((entry) => !completedByOwners.has(entry.threadKey));
    }

    if (pendingEntries.length === 0) {
      resolveReservation(completedThreadKeys);
      return [];
    }

    const completedByRun = await input.run(pendingEntries, (threadKey) => {
      if (ownedThreadKeys.has(threadKey)) completedThreadKeys.add(threadKey);
    });
    for (const threadKey of completedByRun) {
      if (ownedThreadKeys.has(threadKey)) completedThreadKeys.add(threadKey);
    }
    resolveReservation(completedThreadKeys);
    return completedByRun;
  } catch (error) {
    resolveReservation(completedThreadKeys);
    throw error;
  } finally {
    for (const threadKey of ownedThreadKeys) {
      if (reservations.get(threadKey) === reservation) {
        reservations.delete(threadKey);
      }
    }
  }
}

export function isThreadSessionRunning(
  session: { readonly status: string; readonly activeTurnId?: unknown } | null | undefined,
): boolean {
  return session?.status === "running" && session.activeTurnId != null;
}

type ThreadArchiveState = {
  readonly session: Parameters<typeof isThreadSessionRunning>[0];
  readonly backgroundLiveness?: SidebarThreadSummary["backgroundLiveness"];
};

export function isThreadArchiveBlocked(thread: ThreadArchiveState | null | undefined): boolean {
  return (
    thread?.session?.status === "starting" ||
    isThreadSessionRunning(thread?.session) ||
    thread?.backgroundLiveness != null
  );
}

export function canArchiveSettledSidebarThread(input: {
  readonly threadKey: string;
  readonly settledThreadKeys: ReadonlySet<string>;
  readonly session: ThreadArchiveState["session"];
  readonly backgroundLiveness: ThreadArchiveState["backgroundLiveness"];
}): boolean {
  return (
    input.settledThreadKeys.has(input.threadKey) &&
    !isThreadArchiveBlocked({
      session: input.session,
      backgroundLiveness: input.backgroundLiveness,
    })
  );
}

export function filterArchivableSidebarThreads<T extends ThreadArchiveState>(
  threads: readonly T[],
): T[] {
  return threads.filter((thread) => !isThreadArchiveBlocked(thread));
}
