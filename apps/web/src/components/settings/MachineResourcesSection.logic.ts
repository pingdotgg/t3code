import type { HostResourcesSnapshot } from "@t3tools/contracts";

export function machineCpuDetail(
  snapshot: Pick<HostResourcesSnapshot, "cpuCount" | "cpuModel" | "loadAverage">,
): string {
  const load = snapshot.loadAverage;
  return [
    snapshot.cpuModel,
    `${snapshot.cpuCount} ${snapshot.cpuCount === 1 ? "core" : "cores"}`,
    load
      ? `load ${[load.one, load.five, load.fifteen].map((value) => value.toFixed(2)).join(" ")}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Old servers send no `storage`; that reads as unsupported, never as an empty machine. */
export function machineStorageState(snapshot: Pick<HostResourcesSnapshot, "storage">) {
  const storage = snapshot.storage;
  if (storage === undefined) return { kind: "unsupported" } as const;
  return {
    kind: storage.volumes.length === 0 ? ("empty" as const) : ("volumes" as const),
    volumes: storage.volumes,
    notice: storage.unavailableReason ?? null,
  };
}
