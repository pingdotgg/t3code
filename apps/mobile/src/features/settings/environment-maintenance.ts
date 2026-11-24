import {
  AuthEnvironmentMaintainScope,
  sessionGrantsScope,
  type AuthSessionState,
  type ExecutionEnvironmentCapabilities,
  type ServerProvider,
} from "@t3tools/contracts";
import { CLI_RELEASES_PAGE_URL, newestCliReleaseVersion } from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";
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
const decodeRelease = Schema.decodeUnknownSync(Release);

/** The fork publishes only stable releases, so hosts on any track compare against the latest one. */
export async function findEnvironmentUpdate(currentVersion: string, signal: AbortSignal) {
  // The public release page avoids the anonymous API quota shared by devices on the same network.
  const response = await fetch(`${CLI_RELEASES_PAGE_URL}/latest`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      m(msg("Could not check releases ({status}). Try again.", { status: response.status })),
    );
  }
  const version = newestCliReleaseVersion([decodeRelease(await response.json())], "stable");
  if (version === undefined)
    throw new Error(m(msg("No {channel} release was found.", { channel: "stable" })));
  return compareSemverVersions(version, currentVersion) > 0 ? version : null;
}
