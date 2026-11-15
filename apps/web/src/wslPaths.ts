import { parseWslUncPath, type WslUncPath } from "@t3tools/shared/wslUncPath";

export interface WslEnvironmentCandidate<TEnvironmentId extends string = string> {
  readonly environmentId: TEnvironmentId;
  readonly backendId: string;
  readonly runningDistro: string | null;
}

export interface WslEnvironmentConfiguration {
  readonly enabled: boolean;
  readonly wslOnly: boolean;
  readonly distro: string | null;
  readonly distros: ReadonlyArray<{
    readonly name: string;
    readonly isDefault: boolean;
  }>;
}

export interface WslProjectSelection<TEnvironmentId extends string = string> extends WslUncPath {
  readonly environmentId: TEnvironmentId;
}

const WSL_DEFAULT_BACKEND_ID = "wsl:default";

export function resolveWslProjectSelection<TEnvironmentId extends string>(
  input: string,
  candidates: ReadonlyArray<WslEnvironmentCandidate<TEnvironmentId>>,
): WslProjectSelection<TEnvironmentId> | null {
  const parsed = parseWslUncPath(input);
  if (!parsed) {
    return null;
  }

  const exact = candidates.find((candidate) => {
    if (!candidate.backendId.startsWith("wsl:")) {
      return false;
    }

    const backendDistro = candidate.backendId.slice("wsl:".length);
    const runningDistro =
      candidate.runningDistro ??
      (backendDistro.length > 0 && backendDistro.toLowerCase() !== "default"
        ? backendDistro
        : null);
    return runningDistro?.toLowerCase() === parsed.distro.toLowerCase();
  });
  return exact ? { ...parsed, environmentId: exact.environmentId } : null;
}

interface ConfiguredWslBackend {
  readonly backendId: string;
  readonly runningDistro: string | null;
}

function resolveConfiguredWslBackend(
  configuration: WslEnvironmentConfiguration | null,
): ConfiguredWslBackend | null {
  if (!configuration) {
    return null;
  }

  if (configuration.distro === null) {
    return { backendId: WSL_DEFAULT_BACKEND_ID, runningDistro: null };
  }

  const configuredDistro = configuration.distro.trim();
  if (configuredDistro.length === 0) {
    return null;
  }

  const installedDistro = configuration.distros.find(
    (distro) => distro.name.toLowerCase() === configuredDistro.toLowerCase(),
  );
  const resolvedDistro = installedDistro?.name ?? configuredDistro;
  return { backendId: `wsl:${resolvedDistro}`, runningDistro: resolvedDistro };
}

export function resolveProjectPickerTarget<TEnvironmentId extends string>(input: {
  readonly browseEnvironmentId: TEnvironmentId | null;
  readonly primaryEnvironmentId: TEnvironmentId | null;
  readonly desktopInstanceId: string | null;
  readonly wslConfiguration: WslEnvironmentConfiguration | null;
}): string | null {
  if (input.desktopInstanceId !== null) {
    return input.desktopInstanceId;
  }

  if (
    input.browseEnvironmentId === null ||
    input.browseEnvironmentId !== input.primaryEnvironmentId ||
    !input.wslConfiguration?.enabled ||
    !input.wslConfiguration.wslOnly
  ) {
    return null;
  }

  return resolveConfiguredWslBackend(input.wslConfiguration)?.backendId ?? null;
}

export function applyWslEnvironmentConfiguration<TEnvironmentId extends string>(
  candidates: ReadonlyArray<WslEnvironmentCandidate<TEnvironmentId>>,
  primaryEnvironmentId: TEnvironmentId | null,
  configuration: WslEnvironmentConfiguration | null,
  primaryRunningDistro: string | null = null,
): ReadonlyArray<WslEnvironmentCandidate<TEnvironmentId>> {
  if (!configuration) {
    return candidates;
  }

  const configuredBackend = resolveConfiguredWslBackend(configuration);
  if (!configuredBackend) {
    return candidates;
  }

  if (
    configuration.enabled &&
    configuration.wslOnly &&
    primaryEnvironmentId !== null &&
    !candidates.some((candidate) => candidate.environmentId === primaryEnvironmentId)
  ) {
    return [
      ...candidates,
      {
        environmentId: primaryEnvironmentId,
        ...configuredBackend,
        runningDistro: primaryRunningDistro ?? configuredBackend.runningDistro,
      },
    ];
  }

  return candidates;
}
