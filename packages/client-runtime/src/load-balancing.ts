import type { HostResourcesSnapshot } from "@t3tools/contracts";

/** Callers supply only connected machines hosting the project and selected provider. */
export function chooseLoadBalancedEnvironment(
  candidates: ReadonlyArray<{
    environmentId: string;
    resources: HostResourcesSnapshot | null;
    /** Client receipt time avoids comparing clocks on different machines. */
    receivedAt?: number;
    weight: number;
  }>,
  now: number,
): {
  environmentId: string | null;
  status: "selected" | "no-candidates" | "unavailable" | "at-capacity";
} {
  let selected: string | null = null;
  let bestScore = 0;
  let eligible = 0;
  let unavailable = false;
  for (const { environmentId, resources, receivedAt, weight } of candidates) {
    if (!Number.isFinite(weight) || weight <= 0) continue;
    eligible++;
    const sampledAt = receivedAt ?? resources?.sampledAt ?? 0;
    if (
      !resources ||
      now - sampledAt > 15_000 ||
      sampledAt > now + 5_000 ||
      resources.cpuUtilization === null ||
      resources.totalMemoryBytes <= 0 ||
      resources.cpuCount <= 0
    ) {
      unavailable = true;
      continue;
    }
    const memoryAvailable = resources.availableMemoryBytes / resources.totalMemoryBytes;
    if (resources.cpuUtilization >= 0.95 || memoryAvailable <= 0.05) continue;
    const score = weight * resources.cpuCount * (1 - resources.cpuUtilization) * memoryAvailable;
    if (score > bestScore) {
      selected = environmentId;
      bestScore = score;
    }
  }
  return {
    environmentId: selected,
    status:
      selected !== null
        ? "selected"
        : eligible === 0
          ? "no-candidates"
          : unavailable
            ? "unavailable"
            : "at-capacity",
  };
}
