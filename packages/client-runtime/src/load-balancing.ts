import type {
  ExecutionEnvironmentPlatformOs,
  HostResourcesSnapshot,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";

/** An explicit requirement applies only to automatically routed drafts. */
export type RequiredPlatformOs = Exclude<ExecutionEnvironmentPlatformOs, "unknown"> | null;

export const AUTO_BALANCE_PLATFORMS = [
  { value: "any", label: "Any platform" },
  { value: "darwin", label: "macOS" },
  { value: "linux", label: "Linux" },
  { value: "windows", label: "Windows" },
] as const;

/** Unknown or missing descriptors can participate only in unrestricted routing. */
export function matchesRequiredPlatform(
  platformOs: ExecutionEnvironmentPlatformOs | undefined,
  requiredPlatformOs: RequiredPlatformOs,
): boolean {
  return requiredPlatformOs === null || platformOs === requiredPlatformOs;
}

/** Keep provider-instance and connection eligibility identical for selection and send guards. */
export function isLoadBalancingCandidate(
  environment:
    | {
        connection: { phase: string };
        serverConfig: {
          environment: { platform: { os: ExecutionEnvironmentPlatformOs } };
          providers: ReadonlyArray<
            Pick<
              ServerProvider,
              "instanceId" | "driver" | "enabled" | "installed" | "status" | "auth" | "availability"
            >
          >;
        } | null;
      }
    | undefined,
  weight: number,
  providerDriver: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId | null,
  requiredPlatformOs: RequiredPlatformOs = null,
): boolean {
  return Boolean(
    environment?.connection.phase === "connected" &&
    weight > 0 &&
    matchesRequiredPlatform(
      environment.serverConfig?.environment.platform.os,
      requiredPlatformOs,
    ) &&
    environment.serverConfig?.providers.some(
      (provider) =>
        (providerInstanceId === null || provider.instanceId === providerInstanceId) &&
        provider.driver === providerDriver &&
        provider.enabled &&
        provider.installed &&
        provider.status !== "error" &&
        provider.auth.status !== "unauthenticated" &&
        provider.availability !== "unavailable",
    ),
  );
}

/** Explain the failed stage without claiming a connected but busy machine is missing. */
export function platformRoutingUnavailableReason(
  requiredPlatformOs: Exclude<RequiredPlatformOs, null>,
  hasEligibleEnvironment: boolean,
): string {
  const label = AUTO_BALANCE_PLATFORMS.find(
    (platform) => platform.value === requiredPlatformOs,
  )!.label;
  return hasEligibleEnvironment
    ? `No eligible ${label} environment has usable resource capacity. Choose a machine manually or retry Auto balance.`
    : `No connected ${label} environment is eligible for Auto balance with this project and provider. Change the platform or choose a machine manually.`;
}

/** Callers supply only connected machines hosting the project and selected provider. */
export function chooseLoadBalancedEnvironment(
  candidates: ReadonlyArray<{
    environmentId: string;
    platformOs?: ExecutionEnvironmentPlatformOs;
    resources: HostResourcesSnapshot | null;
    /** Client receipt time avoids comparing clocks on different machines. */
    receivedAt?: number;
    weight: number;
  }>,
  now: number,
  requiredPlatformOs: RequiredPlatformOs = null,
): string | null {
  let selected: string | null = null;
  let bestScore = 0;
  for (const { environmentId, platformOs, resources, receivedAt, weight } of candidates) {
    if (!matchesRequiredPlatform(platformOs, requiredPlatformOs)) continue;
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

/** A saved Auto requirement must not disappear when balancing cannot run. */
export function isAutomaticPlatformRoutingBlocked(input: {
  requiredPlatformOs: RequiredPlatformOs;
  environmentSelection: "auto" | "manual" | undefined;
  selectedEnvironmentId: string | null | undefined;
  currentEnvironmentId: string;
  eligibleEnvironmentIds: readonly string[];
}): boolean {
  return (
    input.requiredPlatformOs !== null &&
    input.environmentSelection !== "manual" &&
    (!input.selectedEnvironmentId ||
      input.selectedEnvironmentId !== input.currentEnvironmentId ||
      !input.eligibleEnvironmentIds.includes(input.selectedEnvironmentId))
  );
}
