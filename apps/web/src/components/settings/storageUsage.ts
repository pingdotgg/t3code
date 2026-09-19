import type { StorageCleanupPreview, StorageUsageTotals } from "@t3tools/contracts";

/** Sum environment-local measurements; project counts represent physical checkouts. */
export function combineStorageUsage(
  summaries: readonly StorageCleanupPreview[],
): StorageCleanupPreview | null {
  if (summaries.length === 0) return null;
  const total = { folders: 0, measured: 0, bytes: 0 };
  const categories = new Map<
    StorageCleanupPreview["categories"][number]["kind"],
    StorageCleanupPreview["categories"][number]
  >();
  const add = (
    target: { folders: number; measured: number; bytes: number },
    source: StorageUsageTotals,
  ) => {
    target.folders += source.folders;
    target.measured += source.measured;
    target.bytes += source.bytes;
  };
  let checkedAt = summaries[0]!.checkedAt;
  let unchecked = 0;
  let unavailable = 0;
  let projectCount = 0;
  for (const summary of summaries) {
    add(total, summary.total);
    if (summary.checkedAt < checkedAt) checkedAt = summary.checkedAt;
    unchecked += summary.unchecked;
    unavailable += summary.unavailable;
    projectCount += summary.projectCount;
    for (const category of summary.categories) {
      const combined = categories.get(category.kind) ?? {
        kind: category.kind,
        folders: 0,
        measured: 0,
        bytes: 0,
      };
      add(combined, category);
      categories.set(category.kind, combined);
    }
  }
  return {
    checkedAt,
    unchecked,
    unavailable,
    total,
    categories: [...categories.values()],
    projectCount,
  };
}
