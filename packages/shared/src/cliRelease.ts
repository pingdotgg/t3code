/**
 * Naming shared by the release workflow, the runtime installers, and
 * install scripts for the per-platform CLI archives attached to GitHub
 * Releases. Every consumer derives the same file names from a version and a
 * platform key, so a rename here is a release-breaking change.
 */

export const CLI_RELEASE_REPOSITORY = "pingdotgg/t3code";
export const CLI_RELEASE_CHECKSUMS_FILE = "SHA256SUMS";
/** Overrides the download origin for mirrors and air-gapped installs. */
export const CLI_RELEASE_BASE_URL_ENV = "T3CODE_RELEASE_BASE_URL";

export type CliArchivePlatformKey =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "win32-arm64"
  | "win32-x64";

export function cliArchivePlatformKey(
  platform: NodeJS.Platform,
  arch: string,
): CliArchivePlatformKey | undefined {
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") return undefined;
  if (arch !== "arm64" && arch !== "x64") return undefined;
  return `${platform}-${arch}`;
}

export function cliArchiveStem(version: string, platformKey: CliArchivePlatformKey): string {
  return `t3-${version}-${platformKey}`;
}

export function cliArchiveFileName(version: string, platformKey: CliArchivePlatformKey): string {
  return `${cliArchiveStem(version, platformKey)}.${platformKey.startsWith("win32") ? "zip" : "tar.gz"}`;
}

/** Directory that `releases/download/<tag>/<asset>` lives under. */
export function cliReleaseDownloadBaseUrl(
  version: string,
  baseUrl = `https://github.com/${CLI_RELEASE_REPOSITORY}/releases/download`,
): string {
  return `${baseUrl.replace(/\/+$/, "")}/v${version}`;
}

/**
 * Parses the `sha256sum` style checksum file attached to each release.
 * Lines are `<hex>  <file>`; a leading `*` marks binary mode and is ignored.
 */
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

/** Whether a version was published from a release train that ships archives. */
export function isArchiveDistributedVersion(version: string): boolean {
  return /-preview\.\d{8}\.\d+$/.test(version);
}
