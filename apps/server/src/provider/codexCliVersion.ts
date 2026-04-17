import { compareCliVersions, normalizeCliVersion } from "./cliVersion.ts";

const CODEX_VERSION_PATTERN = /\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/;

export const MINIMUM_CODEX_CLI_VERSION = "0.37.0";

export const compareCodexCliVersions = compareCliVersions;

export function parseCodexCliVersion(output: string): string | null {
  const match = CODEX_VERSION_PATTERN.exec(output);
  if (!match?.[1]) {
    return null;
  }

  return normalizeCliVersion(match[1]);
}

export function isCodexCliVersionSupported(version: string): boolean {
  return compareCodexCliVersions(version, MINIMUM_CODEX_CLI_VERSION) >= 0;
}

export function formatCodexCliUpgradeMessage(version: string | null): string {
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Codex CLI ${versionLabel} is too old for T3 Code. Upgrade to v${MINIMUM_CODEX_CLI_VERSION} or newer and restart T3 Code.`;
}
