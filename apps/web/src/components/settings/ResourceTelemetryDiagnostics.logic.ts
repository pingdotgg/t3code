import type { ResourceTelemetryProcess, ResourceTelemetrySourceStatus } from "@t3tools/contracts";

function processIdentityKey(process: ResourceTelemetryProcess): string {
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
