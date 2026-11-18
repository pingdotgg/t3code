import type { HostResourcesSnapshot } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

/** Short binary-unit size for at-a-glance machine stats, e.g. "11 GB" or "1.2 TB". */
export function formatHostBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Under 10% free, capped at 20 GB so a large disk with plenty left stays calm. */
export function isHostDiskLow(snapshot: HostResourcesSnapshot): boolean {
  const disk = snapshot.disk;
  return (
    disk !== undefined && disk.availableBytes < Math.min(disk.totalBytes * 0.1, 20 * 1024 ** 3)
  );
}

/** One line for pickers and lists: "11 GB free on home volume · 9.4 GB RAM free · 3 updates". */
export function hostResourcesSummary(
  snapshot: HostResourcesSnapshot,
  resolve: MFunctionType = mFallback,
): string {
  const updates = snapshot.osUpdates?.available ?? 0;
  return [
    snapshot.disk
      ? resolve(msg("{available} free on home volume"), {
          available: formatHostBytes(snapshot.disk.availableBytes),
        })
      : null,
    snapshot.totalMemoryBytes > 0
      ? resolve(msg("{available} RAM free"), {
          available: formatHostBytes(snapshot.availableMemoryBytes),
        })
      : null,
    updates > 0
      ? resolve(msg("{count, plural, one {{count} update} other {{count} updates}}"), {
          count: updates,
        })
      : null,
    snapshot.rebootRequired ? resolve(msg("restart required")) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}
