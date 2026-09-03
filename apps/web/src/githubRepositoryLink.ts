export interface GitHubRepositoryLink {
  readonly href: string;
  readonly nameWithOwner: string;
}

export interface GitHubRepositoryLinkMatch extends GitHubRepositoryLink {
  readonly source: string;
  readonly start: number;
  readonly end: number;
}

const GITHUB_REPOSITORY_HOSTNAMES = new Set(["github.com", "www.github.com"]);
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9-]+$/u;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+$/u;
const GITHUB_REPOSITORY_URL_PATTERN = /(^|\s)(https?:\/\/(?:www\.)?github\.com\/\S+)(?=\s)/giu;
const TRAILING_LINK_PUNCTUATION_PATTERN = /[.,!?;:)\]}]+$/u;

function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function parseGitHubRepositoryLink(
  href: string | null | undefined,
): GitHubRepositoryLink | null {
  if (!href) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !GITHUB_REPOSITORY_HOSTNAMES.has(url.hostname.toLowerCase()) ||
    url.port.length > 0 ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean).map(decodePathSegment);
  if (segments.length !== 2 || segments.some((segment) => segment === null)) {
    return null;
  }

  const owner = segments[0];
  const repository = segments[1]?.replace(/\.git$/iu, "");
  if (
    !owner ||
    !repository ||
    owner === "." ||
    owner === ".." ||
    repository === "." ||
    repository === ".." ||
    repository.endsWith(".") ||
    !GITHUB_OWNER_PATTERN.test(owner) ||
    !GITHUB_REPOSITORY_PATTERN.test(repository)
  ) {
    return null;
  }

  return {
    href,
    nameWithOwner: `${owner}/${repository}`,
  };
}

function trimTrailingLinkPunctuation(candidate: string): string {
  return candidate.replace(TRAILING_LINK_PUNCTUATION_PATTERN, "");
}

export function collectGitHubRepositoryLinkMatches(
  text: string,
): ReadonlyArray<GitHubRepositoryLinkMatch> {
  const matches: GitHubRepositoryLinkMatch[] = [];

  for (const match of text.matchAll(GITHUB_REPOSITORY_URL_PATTERN)) {
    const prefix = match[1] ?? "";
    const candidate = match[2] ?? "";
    const source = trimTrailingLinkPunctuation(candidate);
    const parsed = parseGitHubRepositoryLink(source);
    if (!parsed) continue;

    const start = (match.index ?? 0) + prefix.length;
    matches.push({
      ...parsed,
      source,
      start,
      end: start + source.length,
    });
  }

  return matches;
}
