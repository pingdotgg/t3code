import {
  AuthEnvironmentMaintainScope,
  sessionGrantsScope,
  type AuthSessionState,
  type ExecutionEnvironmentCapabilities,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  CLI_RELEASES_PAGE_URL,
  cliReleaseChannelOf,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
} from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Option from "effect/Option";
import { msg } from "gt-react-native";
import * as Schema from "effect/Schema";

import { m } from "../../i18n/messages";

export function canMaintainEnvironment(session: AuthSessionState | null, connected: boolean) {
  return (
    connected &&
    session?.authenticated === true &&
    sessionGrantsScope(session, AuthEnvironmentMaintainScope)
  );
}

export function supportsEnvironmentUpdate(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "serverSelfUpdate" | "desktopAppUpdate">,
) {
  return (
    capabilities.serverSelfUpdate !== undefined &&
    (capabilities.serverSelfUpdate !== "desktop-managed" || capabilities.desktopAppUpdate === true)
  );
}

export function canUpdateEnvironmentProvider(provider: ServerProvider) {
  const compatibility = provider.compatibilityAdvisory?.latestVersionStatus;
  return (
    provider.installed &&
    provider.availability !== "unavailable" &&
    provider.versionAdvisory?.status === "behind_latest" &&
    provider.versionAdvisory.canUpdate &&
    provider.versionAdvisory.latestVersion !== null &&
    compatibility !== "broken" &&
    compatibility !== "unsupported" &&
    provider.updateState?.status !== "running" &&
    provider.updateState?.status !== "queued"
  );
}

const Release = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.optionalKey(Schema.Boolean),
});
const decodeReleases = Schema.decodeUnknownOption(Schema.Array(Release));

async function fetchReleases(url: string, accept: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, headers: { Accept: accept } });
  if (!response.ok) {
    throw new Error(
      m(msg("Could not check releases ({status}). Try again.", { status: response.status })),
    );
  }
  return response;
}

export async function findEnvironmentUpdate(currentVersion: string, signal: AbortSignal) {
  const channel = cliReleaseChannelOf(currentVersion);
  // The public feed avoids the anonymous API quota shared by devices on the same network.
  // Not /releases/latest: it redirects to the release list when every release is a prerelease.
  const feed = await fetchReleases(`${CLI_RELEASES_PAGE_URL}.atom`, "application/atom+xml", signal);
  let version = newestCliReleaseVersion(
    Array.from(
      (await feed.text()).matchAll(/<id>tag:github\.com,2008:Repository\/\d+\/([^<]+)<\/id>/g),
      ([, tag_name = ""]) => ({ tag_name }),
    ),
    channel,
  );

  // The feed only includes ten releases, so later nightlies can displace an older release.
  for (let page = 1; version === undefined; page++) {
    const response = await fetchReleases(
      cliReleaseIndexPageUrl(page),
      "application/vnd.github+json",
      signal,
    );
    const releases = Option.getOrUndefined(decodeReleases(await response.json()));
    if (releases === undefined) throw new Error("Could not read the release list. Try again.");
    version = newestCliReleaseVersion(releases, channel);
    if (releases.length < 100) break;
  }

  if (version === undefined)
    throw new Error(m(msg("No {channel} release was found.", { channel })));
  return compareSemverVersions(version, currentVersion) > 0 ? version : null;
}
