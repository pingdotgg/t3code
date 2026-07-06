import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderProjectCapabilitiesInput,
} from "@t3tools/contracts";

export interface ProviderProjectCapabilitiesTarget {
  readonly environmentId: EnvironmentId | null;
  readonly providerInstanceId: ProviderInstanceId | null | undefined;
  readonly cwd: string | null | undefined;
  readonly providers?: ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "enabled" | "installed" | "availability">
  > | null;
}

export interface ProviderProjectCapabilitiesQueryTarget {
  readonly environmentId: EnvironmentId;
  readonly input: ServerProviderProjectCapabilitiesInput;
}

function isProviderCapabilityQueryable(
  provider: Pick<ServerProvider, "enabled" | "installed" | "availability">,
): boolean {
  return provider.enabled && provider.installed && provider.availability !== "unavailable";
}

export function buildProviderProjectCapabilitiesQueryTarget(
  target: ProviderProjectCapabilitiesTarget,
): ProviderProjectCapabilitiesQueryTarget | null {
  if (
    target.environmentId === null ||
    target.providerInstanceId === null ||
    target.providerInstanceId === undefined ||
    target.cwd === null ||
    target.cwd === undefined ||
    target.cwd.trim().length === 0
  ) {
    return null;
  }

  if (target.providers !== undefined) {
    const provider = target.providers?.find(
      (candidate) => candidate.instanceId === target.providerInstanceId,
    );
    if (!provider || !isProviderCapabilityQueryable(provider)) {
      return null;
    }
  }

  return {
    environmentId: target.environmentId,
    input: {
      providerInstanceId: target.providerInstanceId,
      cwd: target.cwd,
    },
  };
}
