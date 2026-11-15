import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@t3tools/contracts";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";

const RUNTIME_NAMES: Partial<Record<string, string>> = {
  claudeAgent: "Claude Code",
  codex: "the Codex CLI",
};

function formatModelList(names: ReadonlyArray<string>): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function withV(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

export function formatProviderUpdateRequiredNotice(
  provider: Pick<ServerProvider, "driver" | "updateRequiredModels" | "versionAdvisory">,
  searchQuery = "",
): string | null {
  const query = searchQuery.trim().toLocaleLowerCase();
  const models = (provider.updateRequiredModels ?? []).filter(
    (model) =>
      query.length === 0 ||
      model.name.toLocaleLowerCase().includes(query) ||
      model.slug.toLocaleLowerCase().includes(query),
  );
  if (models.length === 0) return null;
  const minVersion = models
    .map((model) => model.minVersion)
    .reduce((highest, version) =>
      compareSemverVersions(version, highest) > 0 ? version : highest,
    );
  const providerName =
    RUNTIME_NAMES[provider.driver] ?? PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
  const names = formatModelList(models.map((model) => model.name));
  const latestVersion = provider.versionAdvisory?.latestVersion;
  if (
    latestVersion &&
    parseSemver(latestVersion) &&
    parseSemver(minVersion) &&
    compareSemverVersions(latestVersion, minVersion) < 0
  ) {
    return `${names} ${models.length === 1 ? "needs" : "need"} ${providerName} ${withV(minVersion)} or newer, but the newest this install can update to is ${withV(latestVersion)}. Install ${providerName} another way or wait for a newer release.`;
  }
  return `Update ${providerName} to ${withV(minVersion)} or newer to use ${names}.`;
}
