import {
  normalizeCommandPath,
  selectVersionGatedProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "./providerMaintenance.ts";

// `codex update` first shipped in a prerelease, but 0.128.0 was the first
// stable npm release containing it. Keep the stable release as the conservative
// boundary so older and indeterminate installations retain path-based updates.
export const CODEX_NATIVE_UPDATE_MINIMUM_VERSION = "0.128.0";

const LEGACY_ONLY_UPDATE_EXECUTABLES = new Set(["pnpm", "vp"]);

export function makeCodexMaintenanceEnvironment(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly realExecutablePath: string | null;
  readonly sharedHomePath: string;
}): NodeJS.ProcessEnv {
  if (!input.realExecutablePath) {
    return input.environment;
  }
  const executablePath = normalizeCommandPath(input.realExecutablePath);
  const sharedHomePath = normalizeCommandPath(input.sharedHomePath).replace(/\/+$/, "");
  const standaloneReleasesPath = `${sharedHomePath}/packages/standalone/releases/`;
  if (!executablePath.startsWith(standaloneReleasesPath)) {
    return input.environment;
  }
  return {
    ...input.environment,
    CODEX_HOME: input.sharedHomePath,
  };
}

export function selectCodexProviderMaintenanceCapabilities(input: {
  readonly installedVersion: string | null | undefined;
  readonly legacyCapabilities: ProviderMaintenanceCapabilities;
  readonly executable: string;
  readonly environment?: NodeJS.ProcessEnv;
}): ProviderMaintenanceCapabilities {
  if (
    input.legacyCapabilities.update &&
    LEGACY_ONLY_UPDATE_EXECUTABLES.has(input.legacyCapabilities.update.executable)
  ) {
    return input.legacyCapabilities;
  }

  return selectVersionGatedProviderMaintenanceCapabilities({
    currentVersion: input.installedVersion,
    minimumVersion: CODEX_NATIVE_UPDATE_MINIMUM_VERSION,
    legacyCapabilities: input.legacyCapabilities,
    nativeUpdate: {
      executable: input.executable,
      args: ["update"],
      lockKey: input.legacyCapabilities.update?.lockKey ?? "codex-native",
      ...(input.environment ? { env: input.environment } : {}),
    },
  });
}
