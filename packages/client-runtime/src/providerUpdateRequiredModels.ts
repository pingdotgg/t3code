import {
  PROVIDER_DISPLAY_NAMES,
  type ServerProvider,
  type ServerProviderVersionAdvisory,
} from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";

const RUNTIME_NAMES: Partial<Record<string, string>> = {
  claudeAgent: "Claude Code",
  codex: "the Codex CLI",
};

function formatModelList(names: ReadonlyArray<string>): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * A Homebrew cask upgrade can only reach the versions that cask ships; when the
 * model needs a newer one, the pinned `<cask>@latest` cask is the way out.
 */
function homebrewCaskLagHint(updateCommand: string | null, version: string): string | null {
  const cask = updateCommand?.match(/^brew upgrade --cask (\S+)$/)?.[1];
  return cask ? ` For Homebrew, install the ${cask}@latest cask (v${version} or newer).` : null;
}

function channelLagNotice(
  advisory: Pick<ServerProviderVersionAdvisory, "latestVersion" | "updateCommand"> | undefined,
  version: string,
): string | null {
  const latest = advisory?.latestVersion;
  if (!latest || compareSemverVersions(latest, version) >= 0) return null;
  return ` Your install source offers at most v${latest}, so that update won't unlock it.${
    homebrewCaskLagHint(advisory?.updateCommand ?? null, version) ?? ""
  }`;
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
  const version = minVersion.startsWith("v") ? minVersion : `v${minVersion}`;
  const names = formatModelList(models.map((model) => model.name));
  return `Update ${providerName} to ${version} or newer to use ${names}.${
    channelLagNotice(provider.versionAdvisory, minVersion) ?? ""
  }`;
}
