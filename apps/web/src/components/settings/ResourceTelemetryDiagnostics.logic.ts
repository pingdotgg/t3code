import type { ResourceTelemetryProcess, ResourceTelemetrySourceStatus } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

export function processIdentityKey(process: Pick<ResourceTelemetryProcess, "identity">): string {
  return `${process.identity.pid}:${process.identity.startTimeMs}`;
}

export function visibleResourceTelemetryProcesses(
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  collapsed: ReadonlySet<string>,
): ReadonlyArray<ResourceTelemetryProcess> {
  const childrenByParent = new Map<number, ResourceTelemetryProcess[]>();
  for (const process of processes) {
    const children = childrenByParent.get(process.ppid) ?? [];
    children.push(process);
    childrenByParent.set(process.ppid, children);
  }

  const hidden = new Set<string>();
  const hideDescendants = (pid: number): void => {
    for (const child of childrenByParent.get(pid) ?? []) {
      // Depth 0 rows are their own roots, e.g. the server launched by Electron main.
      if (child.depth === 0) continue;
      const key = processIdentityKey(child);
      if (hidden.has(key)) continue;
      hidden.add(key);
      hideDescendants(child.identity.pid);
    }
  };
  for (const process of processes) {
    if (collapsed.has(processIdentityKey(process))) {
      hideDescendants(process.identity.pid);
    }
  }
  return processes.filter((process) => !hidden.has(processIdentityKey(process)));
}

export function shouldShowResourceMonitorRetry(input: {
  readonly nativeStatus: ResourceTelemetrySourceStatus | null;
  readonly error: string | null;
}): boolean {
  return (
    (input.nativeStatus === null && input.error !== null) ||
    input.nativeStatus === "degraded" ||
    input.nativeStatus === "unavailable" ||
    input.nativeStatus === "stopped"
  );
}

export function resourceHistoryBarHeight(input: {
  readonly value: number;
  readonly max: number;
  readonly minimumVisiblePercent: number;
}): number {
  if (input.value <= 0) return 0;
  return Math.max(input.minimumVisiblePercent, (input.value / Math.max(1, input.max)) * 100);
}

export function resourceHistoryCpuScaleMax(
  buckets: ReadonlyArray<{ readonly avgCpuPercent: number }>,
): number {
  return Math.max(1, ...buckets.map((bucket) => bucket.avgCpuPercent));
}

export function formatCpuTime(seconds: number, resolve: MessageResolver = m): string {
  const format = (value: number) => value.toFixed(value >= 10 ? 1 : 2).replace(/\.0+$/, "");
  // Pick the unit after rounding so 59.97 seconds never renders as "60s".
  const shortSeconds = format(seconds);
  if (Number(shortSeconds) < 60) {
    return resolve(msg("{value}s", { value: shortSeconds, $context: "CPU time in seconds" }));
  }
  const shortMinutes = format(seconds / 60);
  if (Number(shortMinutes) < 60) {
    return resolve(msg("{value}m", { value: shortMinutes, $context: "CPU time in minutes" }));
  }
  return resolve(
    msg("{value}h", {
      value: (seconds / 3_600).toFixed(2).replace(/\.0+$/, ""),
      $context: "CPU time in hours",
    }),
  );
}

export function formatSamplingStatus(intervalMs: number, resolve: MessageResolver = m): string {
  // The server reports 0 while the native monitor is idle and samples only on request.
  if (intervalMs <= 0) return resolve(msg("Sampling on demand"));
  if (intervalMs < 1_000) {
    return resolve(msg("Sampling every {ms} ms", { ms: Math.round(intervalMs) }));
  }
  const seconds = intervalMs / 1_000;
  return resolve(
    msg(
      "{count, plural, one {Sampling every {seconds} second} other {Sampling every {seconds} seconds}}",
      {
        count: seconds,
        seconds: seconds.toLocaleString(undefined, { maximumFractionDigits: 1 }),
      },
    ),
  );
}
