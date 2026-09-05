import { parseTimestampDate } from "../../timestampFormat";

export type ArchivedThreadSort = "archived-desc" | "archived-asc" | "created-desc" | "created-asc";

export interface ArchivedThreadListEntry {
  readonly thread: {
    readonly id: string;
    readonly environmentId: string;
    readonly title: string;
    readonly archivedAt: string | null;
    readonly createdAt: string;
  };
  readonly project: {
    readonly id: string;
    readonly environmentId: string;
    readonly name: string;
    readonly cwd: string;
  };
}

export interface ArchivedThreadListFilters {
  readonly query: string;
  readonly environmentId: string;
  readonly projectKey: string;
  readonly sort: ArchivedThreadSort;
}

export interface ArchivedThreadBulkResult {
  readonly completedCount: number;
  readonly failedCount: number;
  readonly cancelled: boolean;
}

export function archivedThreadSortDate(
  thread: ArchivedThreadListEntry["thread"],
  sort: ArchivedThreadSort,
): string {
  return sort.startsWith("created-") ? thread.createdAt : (thread.archivedAt ?? thread.createdAt);
}

/** Build the environment-scoped key used by archived-thread selection state. */
export function archivedThreadKey(entry: ArchivedThreadListEntry): string {
  return archivedThreadRefKey({
    environmentId: entry.thread.environmentId,
    threadId: entry.thread.id,
  });
}

export function archivedThreadRefKey(ref: {
  readonly environmentId: string;
  readonly threadId: string;
}): string {
  return JSON.stringify([ref.environmentId, ref.threadId]);
}

/** Build the environment-scoped key used by the project filter. */
export function archivedProjectKey(entry: ArchivedThreadListEntry): string {
  return archivedProjectRefKey({
    environmentId: entry.project.environmentId,
    projectId: entry.project.id,
  });
}

export function archivedProjectRefKey(ref: {
  readonly environmentId: string;
  readonly projectId: string;
}): string {
  return JSON.stringify([ref.environmentId, ref.projectId]);
}

/** Apply archive-browser search, scope filters, and date ordering. */
export function filterAndSortArchivedThreads<T extends ArchivedThreadListEntry>(
  entries: readonly T[],
  filters: ArchivedThreadListFilters,
): T[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return entries
    .filter(
      (entry) =>
        (filters.environmentId === "all" || entry.thread.environmentId === filters.environmentId) &&
        (filters.projectKey === "all" || archivedProjectKey(entry) === filters.projectKey) &&
        (!query ||
          entry.thread.title.toLocaleLowerCase().includes(query) ||
          entry.project.name.toLocaleLowerCase().includes(query) ||
          entry.project.cwd.toLocaleLowerCase().includes(query)),
    )
    .toSorted((left, right) => {
      const leftDate = archivedThreadSortDate(left.thread, filters.sort);
      const rightDate = archivedThreadSortDate(right.thread, filters.sort);
      const direction = filters.sort.endsWith("-asc") ? 1 : -1;
      return (
        direction * Math.sign(Date.parse(leftDate) - Date.parse(rightDate)) ||
        right.thread.id.localeCompare(left.thread.id)
      );
    });
}

/** Return the local-calendar section label for one archived-thread timestamp. */
export function archivedThreadDateSectionLabel(
  isoDate: string,
  now = new Date(),
  locales?: Intl.LocalesArgument,
): string {
  const date = parseTimestampDate(isoDate);
  if (date === null) return "Unknown date";
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date >= today && date < tomorrow) return "Today";
  if (date >= tomorrow) {
    return new Intl.DateTimeFormat(locales, {
      month: "long",
      day: "numeric",
      year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
    }).format(date);
  }
  if (date >= yesterday) return "Yesterday";
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) {
    return "Earlier this month";
  }
  return new Intl.DateTimeFormat(locales, {
    month: "long",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).format(date);
}

/** Run per-thread mutations with bounded concurrency and stop scheduling work after cancellation. */
export async function runArchivedThreadBulkAction<T>(input: {
  readonly entries: readonly T[];
  readonly action: (entry: T) => Promise<boolean>;
  readonly isCancelled: () => boolean;
  readonly concurrency?: number;
}): Promise<ArchivedThreadBulkResult> {
  const concurrency = Math.max(1, Math.min(input.concurrency ?? 4, input.entries.length));
  let nextIndex = 0;
  let completedCount = 0;
  let failedCount = 0;

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (!input.isCancelled()) {
        const index = nextIndex++;
        const entry = input.entries[index];
        if (entry === undefined) return;
        const succeeded = await input.action(entry).catch(() => false);
        completedCount += 1;
        if (!succeeded) failedCount += 1;
      }
    }),
  );

  return {
    completedCount,
    failedCount,
    cancelled: nextIndex < input.entries.length,
  };
}
