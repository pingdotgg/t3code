import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@t3tools/contracts";

// Name the thing the user updates; "Claude" alone reads like the app or model.
const RUNTIME_NAMES: Partial<Record<string, string>> = {
  claudeAgent: "Claude Code",
  codex: "the Codex CLI",
};

function formatModelList(names: ReadonlyArray<string>): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * Model picker notice for models the manifest announces but the installed
 * provider is too old to run, e.g. "Update Claude Code to v2.1.300 or newer to
 * use Claude Opus 6." Null when nothing is gated.
 */
export function formatProviderUpdateRequiredNotice(
  provider: Pick<ServerProvider, "driver" | "updateRequiredModels">,
): string | null {
  const models = provider.updateRequiredModels ?? [];
  if (models.length === 0) return null;
  // The highest bar unlocks every listed model.
  const minVersion = models
    .map((model) => model.minVersion)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0]!;
  const providerName =
    RUNTIME_NAMES[provider.driver] ?? PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
  const version = minVersion.startsWith("v") ? minVersion : `v${minVersion}`;
  const names = formatModelList(models.map((model) => model.name));
  return `Update ${providerName} to ${version} or newer to use ${names}.`;
}
