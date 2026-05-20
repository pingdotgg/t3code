import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderCompatibilityAdvisory,
  ServerProviderVersionAdvisory,
} from "@t3tools/contracts";

export interface ProviderVersionAdvisoryPresentation {
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly emphasis: "normal" | "strong";
}

export interface ProviderCompatibilityAdvisoryPresentation {
  readonly title: string;
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly canUpdate: boolean;
  readonly emphasis: "normal" | "strong";
}

export interface ProviderCompatibilityUpdateRequest {
  readonly provider: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly targetVersion: string;
}

export interface ProviderCompatibilityUpdateTracker {
  readonly updatingInstanceIds: ReadonlySet<ProviderInstanceId>;
}

/**
 * Normalize a version string for display. Adds the `v` prefix when the driver
 * reported a bare version (e.g. `1.2.3`) so clients render consistently.
 */
export function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  return version.startsWith("v") ? version : `v${version}`;
}

export function getProviderVersionAdvisoryPresentation(
  advisory: ServerProviderVersionAdvisory | undefined,
): ProviderVersionAdvisoryPresentation | null {
  if (!advisory || advisory.status === "current" || advisory.status === "unknown") {
    return null;
  }

  const label = "Update available";
  const version = advisory.latestVersion;
  const versionLabel = getProviderVersionLabel(version);

  return {
    detail:
      advisory.message ??
      (versionLabel
        ? `${label}: install ${versionLabel}.`
        : `${label}: install the latest provider version.`),
    updateCommand: advisory.updateCommand,
    emphasis: "normal",
  };
}

function makeTargetedUpdateCommand(input: {
  readonly updateCommand: string | null | undefined;
  readonly recommendedVersion: string | null | undefined;
}): string | null {
  if (!input.updateCommand || !input.recommendedVersion) {
    return null;
  }
  if (!input.updateCommand.includes("@latest")) {
    const packageNameMatch = input.updateCommand.match(
      /(?:^|\s)(@[^\s]+\/[^\s@]+|[^\s@]+)(?=\s*$)/,
    );
    if (!packageNameMatch?.[1]) {
      return null;
    }
    return input.updateCommand.replace(
      packageNameMatch[1],
      `${packageNameMatch[1]}@${input.recommendedVersion}`,
    );
  }
  return input.updateCommand.replace("@latest", `@${input.recommendedVersion}`);
}

export function getProviderCompatibilityUpdateCommand(
  provider: Pick<ServerProvider, "compatibilityAdvisory" | "versionAdvisory"> | null | undefined,
): string | null {
  const compatibilityAdvisory = provider?.compatibilityAdvisory;
  if (!compatibilityAdvisory || compatibilityAdvisory.status === "supported") {
    return null;
  }
  return (
    compatibilityAdvisory.updateCommand ??
    makeTargetedUpdateCommand({
      updateCommand: provider.versionAdvisory?.updateCommand,
      recommendedVersion: compatibilityAdvisory.recommendedVersion,
    })
  );
}

export function canRunProviderCompatibilityUpdate(
  provider: Pick<ServerProvider, "compatibilityAdvisory"> | null | undefined,
): boolean {
  const compatibilityAdvisory = provider?.compatibilityAdvisory;
  return Boolean(
    compatibilityAdvisory &&
    compatibilityAdvisory.status !== "supported" &&
    compatibilityAdvisory.canUpdate === true &&
    compatibilityAdvisory.recommendedVersion,
  );
}

export function getProviderCompatibilityUpdateRequest(
  provider:
    | Pick<ServerProvider, "driver" | "instanceId" | "compatibilityAdvisory">
    | null
    | undefined,
): ProviderCompatibilityUpdateRequest | null {
  const targetVersion = provider?.compatibilityAdvisory?.recommendedVersion ?? null;
  if (!provider || !targetVersion || !canRunProviderCompatibilityUpdate(provider)) {
    return null;
  }
  return {
    provider: provider.driver,
    instanceId: provider.instanceId,
    targetVersion,
  };
}

export function getProviderCompatibilityAdvisoryPresentation(
  advisory: ServerProviderCompatibilityAdvisory | undefined,
): ProviderCompatibilityAdvisoryPresentation | null {
  if (!advisory || advisory.status === "supported") {
    return null;
  }

  const recommendedTarget = advisory.recommendedVersion ?? advisory.recommendedRange;
  const recommended = recommendedTarget ? ` Recommended: ${recommendedTarget}.` : "";
  const fallback =
    advisory.status === "unknown"
      ? `Compatibility unknown.${recommended}`
      : `This provider harness is outside the supported range.${recommended}`;

  return {
    title:
      advisory.status === "broken" ? "Incompatible provider version" : "Provider version warning",
    detail: advisory.message ?? fallback,
    updateCommand: advisory.updateCommand ?? null,
    canUpdate: advisory.canUpdate === true,
    emphasis: advisory.severity === "error" ? "strong" : "normal",
  };
}

export function stripProviderCompatibilityInstallHint(
  message: string,
  recommendedVersion: string | null,
) {
  if (!recommendedVersion) {
    return message;
  }
  const escapedVersion = recommendedVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return message.replace(new RegExp(`\\s*Use\\s+${escapedVersion}\\.?\\s*$`, "i"), "").trim();
}

export function createProviderCompatibilityUpdateTracker(
  updatingInstanceIds: Iterable<ProviderInstanceId> = [],
): ProviderCompatibilityUpdateTracker {
  return { updatingInstanceIds: new Set(updatingInstanceIds) };
}

export function isProviderCompatibilityUpdateRunning(
  tracker: ProviderCompatibilityUpdateTracker,
  provider: Pick<ServerProvider, "instanceId"> | null | undefined,
): boolean {
  return Boolean(provider && tracker.updatingInstanceIds.has(provider.instanceId));
}

export function beginProviderCompatibilityUpdate(
  tracker: ProviderCompatibilityUpdateTracker,
  provider: Pick<ServerProvider, "instanceId">,
): { readonly tracker: ProviderCompatibilityUpdateTracker; readonly started: boolean } {
  if (tracker.updatingInstanceIds.has(provider.instanceId)) {
    return { tracker, started: false };
  }
  return {
    tracker: createProviderCompatibilityUpdateTracker([
      ...tracker.updatingInstanceIds,
      provider.instanceId,
    ]),
    started: true,
  };
}

export function endProviderCompatibilityUpdate(
  tracker: ProviderCompatibilityUpdateTracker,
  provider: Pick<ServerProvider, "instanceId">,
): ProviderCompatibilityUpdateTracker {
  if (!tracker.updatingInstanceIds.has(provider.instanceId)) {
    return tracker;
  }
  const next = new Set(tracker.updatingInstanceIds);
  next.delete(provider.instanceId);
  return createProviderCompatibilityUpdateTracker(next);
}
