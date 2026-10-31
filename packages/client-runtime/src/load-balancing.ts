import {
  resolveProjectProviderInstanceEnabled,
  type HostResourcesSnapshot,
  type ProjectId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";

/** How long a host-resources sample counts for a pick. */
export const HOST_RESOURCES_FRESH_MS = 15_000;

/** Whether a provider instance can take a turn for the project on its machine. */
export function providerInstanceReady(input: {
  readonly provider: ServerProvider;
  readonly settings: ServerSettings | null;
  readonly projectId: ProjectId | null;
}): boolean {
  const { provider } = input;
  const enabled = input.settings
    ? resolveProjectProviderInstanceEnabled(input.settings, input.projectId, provider.instanceId)
    : provider.enabled;
  return (
    enabled &&
    provider.installed &&
    provider.status !== "error" &&
    provider.auth.status !== "unauthenticated" &&
    provider.availability !== "unavailable"
  );
}

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
): string | null {
  let selected: string | null = null;
  let bestScore = 0;
  for (const { environmentId, resources, receivedAt, weight } of candidates) {
    const sampledAt = receivedAt ?? resources?.sampledAt ?? 0;
    if (
      !resources ||
      !Number.isFinite(weight) ||
      weight <= 0 ||
      now - sampledAt > HOST_RESOURCES_FRESH_MS ||
      sampledAt > now + 5_000 ||
      resources.cpuUtilization === null ||
      resources.cpuUtilization >= 0.95 ||
      resources.totalMemoryBytes <= 0 ||
      resources.cpuCount <= 0
    ) {
      continue;
    }
    const memoryAvailable = resources.availableMemoryBytes / resources.totalMemoryBytes;
    if (memoryAvailable <= 0.05) continue;
    const score = weight * resources.cpuCount * (1 - resources.cpuUtilization) * memoryAvailable;
    if (score > bestScore) {
      selected = environmentId;
      bestScore = score;
    }
  }
  return selected;
}
