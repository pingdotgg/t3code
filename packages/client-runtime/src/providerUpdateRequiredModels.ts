import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@t3tools/contracts";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import { mFallback, msg } from "gt-i18n";
import { formatConjunctionList } from "./listFormat.ts";
import type { MFunctionType } from "gt-i18n/types";

const CLAUDE_CODE_NAME = "Claude Code";

function withV(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

// The stable cask lags npm; the conflicting claude-code@latest cask tracks it.
const HOMEBREW_STABLE_CASK_UPDATE_COMMAND = "brew upgrade --cask claude-code";
const HOMEBREW_LATEST_CASK_SWITCH_COMMAND =
  "brew uninstall --cask claude-code && brew install --cask claude-code@latest";

type UpdateRequiredProvider = Pick<
  ServerProvider,
  "driver" | "updateRequiredModels" | "versionAdvisory"
>;

function matchingUpdateRequiredModels(provider: UpdateRequiredProvider, searchQuery: string) {
  const query = searchQuery.trim().toLocaleLowerCase();
  return (provider.updateRequiredModels ?? []).filter(
    (model) =>
      query.length === 0 ||
      model.name.toLocaleLowerCase().includes(query) ||
      model.slug.toLocaleLowerCase().includes(query),
  );
}

function highestMinVersion(models: ReadonlyArray<{ readonly minVersion: string }>): string {
  return models
    .map((model) => model.minVersion)
    .reduce((highest, version) =>
      compareSemverVersions(version, highest) > 0 ? version : highest,
    );
}

function channelLatestVersionBelow(
  provider: UpdateRequiredProvider,
  minVersion: string,
): string | null {
  const latestVersion = provider.versionAdvisory?.latestVersion;
  return latestVersion &&
    parseSemver(latestVersion) &&
    parseSemver(minVersion) &&
    compareSemverVersions(latestVersion, minVersion) < 0
    ? latestVersion
    : null;
}

/** True when the provider's own update cannot reach the version its update-required models need. */
export function providerUpdateChannelLags(
  provider: UpdateRequiredProvider,
  searchQuery = "",
): boolean {
  const models = matchingUpdateRequiredModels(provider, searchQuery);
  return (
    models.length > 0 && channelLatestVersionBelow(provider, highestMinVersion(models)) !== null
  );
}

export function formatProviderUpdateRequiredNotice(
  provider: UpdateRequiredProvider,
  searchQuery = "",
  resolve: MFunctionType = mFallback,
  locale = "en",
): string | null {
  const models = matchingUpdateRequiredModels(provider, searchQuery);
  if (models.length === 0) return null;
  const minVersion = highestMinVersion(models);
  const providerName =
    provider.driver === "claudeAgent"
      ? CLAUDE_CODE_NAME
      : (PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver);
  const version = withV(minVersion);
  const names = formatConjunctionList(
    models.map((model) => model.name),
    locale,
    resolve,
  );
  const runtime = provider.driver === "codex" ? "codex" : "other";
  const latestVersion = channelLatestVersionBelow(provider, minVersion);
  if (
    latestVersion &&
    provider.driver === "claudeAgent" &&
    provider.versionAdvisory?.updateCommand === HOMEBREW_STABLE_CASK_UPDATE_COMMAND
  ) {
    return resolve(
      msg(
        "Using {names} requires {providerName} {version} or newer, but the claude-code Homebrew cask only has {latestVersion}. Switch to the claude-code@latest cask: {command}",
        {
          providerName,
          version,
          names,
          latestVersion: withV(latestVersion),
          command: HOMEBREW_LATEST_CASK_SWITCH_COMMAND,
        },
      ),
    );
  }
  if (latestVersion) {
    return resolve(
      msg(
        "{runtime, select, codex {Using {names} requires the Codex CLI {version} or newer, but the newest this install can update to is {latestVersion}. Install the Codex CLI another way or wait for a newer release.} other {Using {names} requires {providerName} {version} or newer, but the newest this install can update to is {latestVersion}. Install {providerName} another way or wait for a newer release.}}",
        { runtime, providerName, version, names, latestVersion: withV(latestVersion) },
      ),
    );
  }
  return resolve(
    msg(
      "{runtime, select, codex {Update the Codex CLI to {version} or newer to use {names}.} other {Update {providerName} to {version} or newer to use {names}.}}",
      {
        runtime,
        providerName,
        version,
        names,
      },
    ),
  );
}
