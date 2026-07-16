import type { ProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import { selectVersionGatedProviderMaintenanceCapabilities } from "./providerMaintenance.ts";

// `codex update` first shipped in a prerelease, but 0.128.0 was the first
// stable npm release containing it. Keep the stable release as the conservative
// boundary so older and indeterminate installations retain path-based updates.
export const CODEX_NATIVE_UPDATE_MINIMUM_VERSION = "0.128.0";

export function selectCodexProviderMaintenanceCapabilities(input: {
  readonly installedVersion: string | null | undefined;
  readonly legacyCapabilities: ProviderMaintenanceCapabilities;
  readonly environment?: NodeJS.ProcessEnv;
}): ProviderMaintenanceCapabilities {
  return selectVersionGatedProviderMaintenanceCapabilities({
    currentVersion: input.installedVersion,
    minimumVersion: CODEX_NATIVE_UPDATE_MINIMUM_VERSION,
    legacyCapabilities: input.legacyCapabilities,
    nativeUpdate: {
      executable: "codex",
      args: ["update"],
      lockKey: "codex-native",
      ...(input.environment ? { env: input.environment } : {}),
    },
  });
}
