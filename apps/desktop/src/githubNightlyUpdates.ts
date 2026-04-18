import { compareDesktopVersions, isNightlyDesktopVersion } from "./updateChannels.ts";

export interface GitHubUpdateRepository {
  readonly owner: string;
  readonly repo: string;
  readonly host?: string;
}

export interface GitHubReleaseAsset {
  readonly name?: unknown;
}

export interface GitHubRelease {
  readonly tag_name?: unknown;
  readonly prerelease?: unknown;
  readonly draft?: unknown;
  readonly assets?: unknown;
}

export interface GitHubNightlyUpdateFeed {
  readonly tag: string;
  readonly version: string;
  readonly feedUrl: string;
}

export interface ResolveLatestGitHubNightlyUpdateFeedOptions {
  readonly repository: GitHubUpdateRepository;
  readonly channelFileName: string;
  readonly token?: string;
  readonly fetcher?: typeof fetch;
}

const NIGHTLY_RELEASE_TAG_PATTERN = /^nightly-v(.+)$/;
const DEFAULT_GITHUB_HOST = "github.com";
const DEFAULT_GITHUB_API_HOST = "api.github.com";

function normalizeGitHubHost(host: string | undefined): string {
  return (host?.trim() || DEFAULT_GITHUB_HOST).replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function resolveGitHubApiBaseUrl(repository: GitHubUpdateRepository): string {
  const host = normalizeGitHubHost(repository.host);
  const encodedOwner = encodeURIComponent(repository.owner);
  const encodedRepo = encodeURIComponent(repository.repo);

  if (host === DEFAULT_GITHUB_HOST || host === DEFAULT_GITHUB_API_HOST) {
    return `https://${DEFAULT_GITHUB_API_HOST}/repos/${encodedOwner}/${encodedRepo}`;
  }

  return `https://${host}/api/v3/repos/${encodedOwner}/${encodedRepo}`;
}

function resolveGitHubDownloadBaseUrl(repository: GitHubUpdateRepository, tag: string): string {
  const host = normalizeGitHubHost(repository.host);
  const downloadHost = host === DEFAULT_GITHUB_API_HOST ? DEFAULT_GITHUB_HOST : host;
  const encodedTag = encodeURIComponent(tag);

  return `https://${downloadHost}/${repository.owner}/${repository.repo}/releases/download/${encodedTag}/`;
}

export function resolveElectronUpdaterChannelFileName(
  channel: string,
  platform: NodeJS.Platform,
  arch: string,
): string {
  if (platform === "darwin") {
    return `${channel}-mac.yml`;
  }

  if (platform === "linux") {
    const archSuffix = arch === "x64" ? "" : `-${arch}`;
    return `${channel}-linux${archSuffix}.yml`;
  }

  return `${channel}.yml`;
}

function parseNightlyReleaseVersion(tagName: string): string | null {
  const match = NIGHTLY_RELEASE_TAG_PATTERN.exec(tagName);
  const version = match?.[1] ?? null;

  return version && isNightlyDesktopVersion(version) ? version : null;
}

function hasChannelAsset(release: GitHubRelease, channelFileName: string): boolean {
  if (!Array.isArray(release.assets)) {
    return false;
  }

  return release.assets.some((asset: GitHubReleaseAsset) => asset.name === channelFileName);
}

export function selectLatestGitHubNightlyUpdateFeed(
  releases: readonly GitHubRelease[],
  repository: GitHubUpdateRepository,
  channelFileName: string,
): GitHubNightlyUpdateFeed | null {
  let selected: { readonly tag: string; readonly version: string } | null = null;

  for (const release of releases) {
    if (release.draft === true || release.prerelease !== true) {
      continue;
    }
    if (typeof release.tag_name !== "string" || !hasChannelAsset(release, channelFileName)) {
      continue;
    }

    const version = parseNightlyReleaseVersion(release.tag_name);
    if (!version) {
      continue;
    }

    if (!selected || compareDesktopVersions(version, selected.version) === 1) {
      selected = { tag: release.tag_name, version };
    }
  }

  return selected
    ? {
        ...selected,
        feedUrl: resolveGitHubDownloadBaseUrl(repository, selected.tag),
      }
    : null;
}

export async function resolveLatestGitHubNightlyUpdateFeed({
  repository,
  channelFileName,
  token,
  fetcher = fetch,
}: ResolveLatestGitHubNightlyUpdateFeedOptions): Promise<GitHubNightlyUpdateFeed | null> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "t3code-desktop-updater",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await fetcher(`${resolveGitHubApiBaseUrl(repository)}/releases?per_page=50`, {
    headers,
  });
  if (!response.ok) {
    throw new Error(`GitHub releases request failed with HTTP ${response.status}.`);
  }

  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("GitHub releases response was not an array.");
  }

  return selectLatestGitHubNightlyUpdateFeed(payload, repository, channelFileName);
}
