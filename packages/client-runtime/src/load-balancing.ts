import {
  resolveProjectProviderInstanceEnabled,
  type HostResourcesSnapshot,
  type ProjectId,
  type ProviderInstanceId,
  type ServerConfig,
} from "@t3tools/contracts";

/** How often a machine receives automatically routed threads, stored as its weight. */
export const LOAD_PREFERENCES = [
  { value: 100, label: "Prefer" },
  { value: 50, label: "Normal" },
  { value: 25, label: "Less often" },
  { value: 0, label: "Manual only" },
] as const;

export type LoadPreference = (typeof LOAD_PREFERENCES)[number]["value"];

/** Snaps a saved weight (older builds stored a slider value) onto the four preferences. */
export function loadPreferenceForWeight(weight: number | undefined): LoadPreference {
  if (weight === undefined || weight === 50) return 50;
  if (weight === 0) return 0;
  return weight < 50 ? 25 : 100;
}

/**
 * Whether a machine can run the draft's provider for its copy of the project.
 * A null instance or driver matches any; the destination project may override
 * the machine's own provider switch.
 */
export function canLoadBalanceToEnvironment(input: {
  readonly providers: ServerConfig["providers"] | undefined;
  readonly settings: ServerConfig["settings"] | undefined;
  readonly projectId: ProjectId | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providerDriver: string | null;
}): boolean {
  const { settings } = input;
  return (input.providers ?? []).some(
    (provider) =>
      (input.providerInstanceId === null || provider.instanceId === input.providerInstanceId) &&
      (input.providerDriver === null || provider.driver === input.providerDriver) &&
      (settings
        ? resolveProjectProviderInstanceEnabled(settings, input.projectId, provider.instanceId)
        : provider.enabled) &&
      provider.installed &&
      provider.status !== "error" &&
      provider.auth.status !== "unauthenticated" &&
      provider.availability !== "unavailable",
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
      now - sampledAt > 15_000 ||
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
