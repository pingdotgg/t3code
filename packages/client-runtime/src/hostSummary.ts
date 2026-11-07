import type { HostResourcesSnapshot } from "@t3tools/contracts";

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

/** One line for pickers and lists: "11 GB disk free · 9.4 GB RAM free · 3 updates". */
export function hostResourcesSummary(snapshot: HostResourcesSnapshot): string {
  const updates = snapshot.osUpdates?.available ?? 0;
  return [
    snapshot.disk ? `${formatHostBytes(snapshot.disk.availableBytes)} disk free` : null,
    snapshot.totalMemoryBytes > 0
      ? `${formatHostBytes(snapshot.availableMemoryBytes)} RAM free`
      : null,
    updates > 0 ? `${updates} ${updates === 1 ? "update" : "updates"}` : null,
    snapshot.rebootRequired ? "restart required" : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}
