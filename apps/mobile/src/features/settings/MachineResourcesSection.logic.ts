import { msg } from "gt-react-native";
import { m, type MessageResolver } from "../../i18n/messages";
import { formatBytes } from "../../lib/formatBytes";
import { machineGpuMemory } from "@t3tools/client-runtime/machine-resources";
import type { HostGpu, HostResourcesSnapshot } from "@t3tools/contracts";

export function formatShare(share: number): string {
  return `${Math.round(share * 100)}%`;
}

export function machineMemoryDetail(
  snapshot: Pick<HostResourcesSnapshot, "availableMemoryBytes" | "swap">,
  resolve: MessageResolver = m,
): string {
  const swap = snapshot.swap;
  return [
    resolve(msg("{bytes} available"), { bytes: formatBytes(snapshot.availableMemoryBytes) }),
    swap && swap.totalBytes > 0
      ? resolve(msg("swap {used} / {total}"), {
          used: formatBytes(swap.usedBytes),
          total: formatBytes(swap.totalBytes),
        })
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Dedicated memory as used/total; a unified-memory GPU shows what its driver holds. */
export function machineGpuDetail(gpu: HostGpu, resolve: MessageResolver = m): string | null {
  const memory = machineGpuMemory(gpu);
  if (memory.kind === "unified")
    return resolve(msg("Unified memory · {bytes} in use"), {
      bytes: formatBytes(memory.usedBytes),
    });
  if (memory.kind === "unreported" || memory.totalBytes <= 0) return null;
  return memory.usedBytes === undefined
    ? resolve(msg("{bytes} memory"), { bytes: formatBytes(memory.totalBytes) })
    : resolve(msg("{used} / {total} memory"), {
        used: formatBytes(memory.usedBytes),
        total: formatBytes(memory.totalBytes),
      });
}

export function machineCoresSummary(
  cores: ReadonlyArray<number>,
  resolve: MessageResolver = m,
): string {
  if (cores.length === 0) return "";
  const busiest = Math.max(...cores);
  return resolve(
    msg("{count, plural, one {{count} core} other {{count} cores}}, busiest {percent}"),
    { count: cores.length, percent: formatShare(busiest) },
  );
}
