import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { compareSemverVersions } from "./semver.ts";

// The fork publishes its own releases; upstream syncs must keep these pointing at the fork.
const CLI_RELEASE_REPOSITORY = "pseudoseed/t3code_dev";
const CLI_RELEASE_TAG_PREFIX = "pseudocode-v";
export const CLI_RELEASES_PAGE_URL = `https://github.com/${CLI_RELEASE_REPOSITORY}/releases`;
const CLI_INSTALL_SCRIPTS_URL = `https://raw.githubusercontent.com/${CLI_RELEASE_REPOSITORY}/main/scripts`;
export const CLI_INSTALL_SH_URL = `${CLI_INSTALL_SCRIPTS_URL}/install.sh`;
export const CLI_INSTALL_PS1_URL = `${CLI_INSTALL_SCRIPTS_URL}/install.ps1`;
export const CLI_RELEASE_CHECKSUMS_FILE = "SHA256SUMS";
export const CLI_RELEASE_BASE_URL_ENV = "T3CODE_RELEASE_BASE_URL";

// Keys build-cli-archive can produce, aligned with the SSH runner's host check in packages/ssh/src/tunnel.ts.
// A release's SHA256SUMS lists the ones it actually publishes.
// Node single-executables do not support darwin-x64 and segfault at startup.
const CLI_ARCHIVE_PLATFORM_KEYS = [
  "darwin-arm64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
] as const;
export type CliArchivePlatformKey = (typeof CLI_ARCHIVE_PLATFORM_KEYS)[number];

export function cliArchivePlatformKey(
  platform: NodeJS.Platform,
  arch: string,
): CliArchivePlatformKey | undefined {
  const key = `${platform}-${arch}`;
  return CLI_ARCHIVE_PLATFORM_KEYS.find((candidate) => candidate === key);
}

/** Use System32 bsdtar on Windows; Git-for-Windows GNU tar cannot open zip archives. */
export function cliArchiveTarCommand(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform !== "win32") return "tar";
  const systemRoot = env["SystemRoot"] ?? env["windir"] ?? "C:\\Windows";
  return `${systemRoot}\\System32\\tar.exe`;
}

export function cliArchiveFileName(version: string, platformKey: CliArchivePlatformKey): string {
  return `t3-${version}-${platformKey}.${platformKey.startsWith("win32") ? "zip" : "tar.gz"}`;
}

const CLI_RELEASE_DEFAULT_BASE_URL = `https://github.com/${CLI_RELEASE_REPOSITORY}/releases/download`;

export function cliReleaseTag(version: string): string {
  return `${CLI_RELEASE_TAG_PREFIX}${version}`;
}

/** The directory holding release `version`'s files. */
export function cliReleaseDownloadBaseUrl(
  version: string,
  baseUrl: string | undefined = CLI_RELEASE_DEFAULT_BASE_URL,
): string {
  return `${(baseUrl?.trim() || CLI_RELEASE_DEFAULT_BASE_URL).replace(/\/+$/, "")}/${cliReleaseTag(version)}`;
}

/** `segments` added to `baseUrl`'s path, keeping its query, such as a signed mirror URL's token. */
export function releaseAssetUrl(baseUrl: string, ...segments: ReadonlyArray<string>): string {
  const url = new URL(baseUrl);
  url.pathname = [url.pathname.replace(/\/+$/, ""), ...segments.map(encodeURIComponent)].join("/");
  return url.toString();
}

/** A file of release `version`, from `baseUrl` laid out as GitHub's release downloads. */
export function cliReleaseAssetUrl(
  version: string,
  fileName: string,
  baseUrl: string | undefined = CLI_RELEASE_DEFAULT_BASE_URL,
): string {
  return releaseAssetUrl(
    baseUrl?.trim() || CLI_RELEASE_DEFAULT_BASE_URL,
    cliReleaseTag(version),
    fileName,
  );
}

export function parseChecksums(text: string): ReadonlyMap<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      checksums.set(match[2], match[1].toLowerCase());
    }
  }
  return checksums;
}

export type CliReleaseChannel = "stable" | "nightly" | "preview";
// The fork publishes no nightly or preview builds, so only Stable can be followed.
export const CLI_RELEASE_CHANNELS = ["stable"] as const satisfies ReadonlyArray<CliReleaseChannel>;

export function cliReleaseChannelOf(version: string): CliReleaseChannel {
  const channel = /^[^-+]+-(nightly|preview)\.\d{8}\.\d+$/.exec(version)?.[1];
  return channel === "nightly" || channel === "preview" ? channel : "stable";
}

/** Whether updating between these versions crosses Stable and Nightly. Preview builds cross nothing.
 * Hosts refuse a crossing outside a track switch, which checks the database first. */
export function crossesReleaseTrack(fromVersion: string, toVersion: string): boolean {
  const from = cliReleaseChannelOf(fromVersion);
  const to = cliReleaseChannelOf(toVersion);
  return from !== to && from !== "preview" && to !== "preview";
}

/** The desktop update track a build belongs to. Preview builds have no feed and read as Stable. */
export function desktopUpdateChannelOf(version: string): "latest" | "nightly" {
  return cliReleaseChannelOf(version) === "nightly" ? "nightly" : "latest";
}

/**
 * The update feed file a desktop app on this platform reads, which an update mirror publishes at
 * its root beside the release's CLI archives.
 */
export function updateFeedFileName(
  channel: "latest" | "nightly",
  platform: NodeJS.Platform,
  arch: string,
): string {
  if (platform === "darwin") return `${channel}-mac.yml`;
  if (platform === "linux")
    return arch === "arm64" ? `${channel}-linux-arm64.yml` : `${channel}-linux.yml`;
  return `${channel}.yml`;
}

/** Whether a track switch may install `found` after its database check cleared `checked`: any build
 * on the switch's track at least as new, since later releases only add migrations. */
export function acceptsTrackSwitchRelease(
  found: string,
  channel: "latest" | "nightly",
  checked: string,
): boolean {
  return (
    cliReleaseChannelOf(found) === (channel === "nightly" ? "nightly" : "stable") &&
    compareSemverVersions(found, checked) >= 0
  );
}

/** Page until the channel matches; nightlies can push preview/stable releases past the first page. */
export function cliReleaseIndexPageUrl(page: number): string {
  return `https://api.github.com/repos/${CLI_RELEASE_REPOSITORY}/releases?per_page=100&page=${page}`;
}

/** Draft assets are not downloadable. */
export function newestCliReleaseVersion(
  releases: ReadonlyArray<{
    readonly tag_name: string;
    readonly draft?: boolean | undefined;
  }>,
  channel: CliReleaseChannel,
): string | undefined {
  for (const release of releases) {
    if (release.draft) continue;
    if (!release.tag_name.startsWith(CLI_RELEASE_TAG_PREFIX)) continue;
    const version = release.tag_name.slice(CLI_RELEASE_TAG_PREFIX.length);
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) continue;
    if (cliReleaseChannelOf(version) === channel) return version;
  }
  return undefined;
}

const NpmReleaseMigrationManifest = Schema.Struct({
  t3code: Schema.Struct({ databaseMigration: Schema.Int }),
});
const decodeNpmReleaseMigrationManifest = Schema.decodeUnknownOption(NpmReleaseMigrationManifest);

/** Highest database migration a release's server knows, from its npm `t3` manifest. */
export function npmReleaseDatabaseMigration(manifest: unknown): number | undefined {
  return Option.getOrUndefined(decodeNpmReleaseMigrationManifest(manifest))?.t3code
    .databaseMigration;
}
