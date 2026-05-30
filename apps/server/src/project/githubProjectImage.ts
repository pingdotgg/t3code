import type { RepositoryIdentity } from "@t3tools/contracts";
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";

export interface GitHubRepositoryRef {
  readonly owner: string;
  readonly name: string;
}

export interface GitHubRepositoryImageMetadata {
  readonly openGraphImageUrl: string | null;
  readonly ownerAvatarUrl: string | null;
}

const GITHUB_REPOSITORY_PAGE_ORIGIN = "https://github.com";
const GITHUB_GENERATED_OPEN_GRAPH_HOST = "opengraph.githubassets.com";
const GITHUB_CUSTOM_REPOSITORY_IMAGE_HOST = "repository-images.githubusercontent.com";
const GITHUB_OWNER_AVATAR_SIZE = 64;

const META_TAG_RE = /<meta\b[^>]*>/gi;
const META_ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*["']([^"']*)["']/g;

function normalizeGitHubPathSegment(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/\.git$/i, "") ?? "";
  if (trimmed.length === 0 || trimmed.includes("/") || trimmed.includes("\\")) {
    return null;
  }
  return trimmed;
}

function parseGitHubRepositoryPath(value: string | null | undefined): GitHubRepositoryRef | null {
  const trimmed = value?.trim() ?? "";
  const match = /^github\.com\/([^/\s]+)\/([^/\s]+)$/i.exec(trimmed);
  if (!match) {
    return null;
  }

  const owner = normalizeGitHubPathSegment(match[1]);
  const name = normalizeGitHubPathSegment(match[2]);
  return owner && name ? { owner, name } : null;
}

function parseGitHubRepositoryRemoteUrl(
  value: string | null | undefined,
): GitHubRepositoryRef | null {
  const nameWithOwner = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(value ?? null);
  if (!nameWithOwner) {
    return null;
  }

  const [rawOwner, rawName] = nameWithOwner.split("/");
  const owner = normalizeGitHubPathSegment(rawOwner);
  const name = normalizeGitHubPathSegment(rawName);
  return owner && name ? { owner, name } : null;
}

function readMetaAttributes(tag: string): ReadonlyMap<string, string> {
  const attrs = new Map<string, string>();
  for (const match of tag.matchAll(META_ATTR_RE)) {
    const name = match[1]?.toLowerCase();
    const value = match[2];
    if (name && value !== undefined) {
      attrs.set(name, value);
    }
  }
  return attrs;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeHttpUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function isGitHubGeneratedOpenGraphImageUrl(value: string): boolean {
  try {
    return new URL(value).hostname === GITHUB_GENERATED_OPEN_GRAPH_HOST;
  } catch {
    return false;
  }
}

function isGitHubCustomRepositoryImageUrl(value: string): boolean {
  try {
    return new URL(value).hostname === GITHUB_CUSTOM_REPOSITORY_IMAGE_HOST;
  } catch {
    return false;
  }
}

function normalizeGitHubCustomRepositoryImageUrl(value: string | null | undefined): string | null {
  const url = normalizeHttpUrl(value);
  if (!url || !isGitHubCustomRepositoryImageUrl(url) || isGitHubGeneratedOpenGraphImageUrl(url)) {
    return null;
  }
  return url;
}

function pushUnique(urls: string[], value: string | null | undefined): void {
  const url = normalizeHttpUrl(value);
  if (url && !urls.includes(url)) {
    urls.push(url);
  }
}

export function resolveGitHubRepositoryRef(
  repositoryIdentity: RepositoryIdentity | null | undefined,
): GitHubRepositoryRef | null {
  if (!repositoryIdentity) {
    return null;
  }

  if (repositoryIdentity.provider?.toLowerCase() === "github") {
    const owner = normalizeGitHubPathSegment(repositoryIdentity.owner);
    const name = normalizeGitHubPathSegment(repositoryIdentity.name);
    if (owner && name) {
      return { owner, name };
    }
  }

  return (
    parseGitHubRepositoryPath(repositoryIdentity.canonicalKey) ??
    parseGitHubRepositoryRemoteUrl(repositoryIdentity.locator.remoteUrl)
  );
}

export function buildGitHubRepositoryPageUrl(repository: GitHubRepositoryRef): string {
  const url = new URL(GITHUB_REPOSITORY_PAGE_ORIGIN);
  url.pathname = `/${repository.owner}/${repository.name}`;
  return url.toString();
}

export function buildGitHubOwnerAvatarUrl(repository: GitHubRepositoryRef): string {
  const url = new URL(`${GITHUB_REPOSITORY_PAGE_ORIGIN}/${repository.owner}.png`);
  url.searchParams.set("size", String(GITHUB_OWNER_AVATAR_SIZE));
  return url.toString();
}

export function extractGitHubCustomRepositoryImageUrl(html: string): string | null {
  for (const match of html.matchAll(META_TAG_RE)) {
    const attrs = readMetaAttributes(match[0]);
    if (attrs.get("property") !== "og:image") {
      continue;
    }

    const content = attrs.get("content")?.trim();
    const customRepositoryImageUrl = normalizeGitHubCustomRepositoryImageUrl(content);
    if (customRepositoryImageUrl) {
      return customRepositoryImageUrl;
    }
  }
  return null;
}

export function parseGitHubRepositoryImageGraphqlResponse(
  stdout: string,
): GitHubRepositoryImageMetadata | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  const root = asRecord(parsed);
  const data = asRecord(root?.data);
  const repository = asRecord(data?.repository);
  if (!repository) {
    return null;
  }

  const owner = asRecord(repository.owner);
  return {
    openGraphImageUrl:
      typeof repository.openGraphImageUrl === "string" ? repository.openGraphImageUrl : null,
    ownerAvatarUrl: typeof owner?.avatarUrl === "string" ? owner.avatarUrl : null,
  };
}

export function buildGitHubProjectImageCandidateUrls(input: {
  readonly repository: GitHubRepositoryRef;
  readonly repositoryImageMetadata?: GitHubRepositoryImageMetadata | null;
  readonly repositoryHtml: string | null;
}): ReadonlyArray<string> {
  const urls: string[] = [];
  pushUnique(
    urls,
    normalizeGitHubCustomRepositoryImageUrl(input.repositoryImageMetadata?.openGraphImageUrl),
  );
  pushUnique(
    urls,
    input.repositoryHtml ? extractGitHubCustomRepositoryImageUrl(input.repositoryHtml) : null,
  );
  pushUnique(urls, input.repositoryImageMetadata?.ownerAvatarUrl);
  const ownerAvatarUrl = buildGitHubOwnerAvatarUrl(input.repository);
  pushUnique(urls, ownerAvatarUrl);

  return urls;
}
