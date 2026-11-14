import { formatBytes } from "../../lib/formatBytes";
import { machineGpuMemory } from "@t3tools/client-runtime/machine-resources";
import type { HostGpu, HostResourcesSnapshot } from "@t3tools/contracts";

export function formatShare(share: number): string {
  return `${Math.round(share * 100)}%`;
}

export function machineMemoryDetail(
  snapshot: Pick<HostResourcesSnapshot, "availableMemoryBytes" | "swap">,
): string {
  const swap = snapshot.swap;
  return [
    `${formatBytes(snapshot.availableMemoryBytes)} available`,
    swap && swap.totalBytes > 0
      ? `swap ${formatBytes(swap.usedBytes)} / ${formatBytes(swap.totalBytes)}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Dedicated memory as used/total; a unified-memory GPU shows what its driver holds. */
export function machineGpuDetail(gpu: HostGpu): string | null {
  const memory = machineGpuMemory(gpu);
  if (memory.kind === "unified") return `Unified memory · ${formatBytes(memory.usedBytes)} in use`;
  if (memory.kind === "unreported" || memory.totalBytes <= 0) return null;
  return memory.usedBytes === undefined
    ? `${formatBytes(memory.totalBytes)} memory`
    : `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)} memory`;
}

export function machineCoresSummary(cores: ReadonlyArray<number>): string {
  if (cores.length === 0) return "";
  const busiest = Math.max(...cores);
  return `${cores.length} ${cores.length === 1 ? "core" : "cores"}, busiest ${formatShare(busiest)}`;
}
