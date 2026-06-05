export interface DiscoveredGitHubPullRequest {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly externalId: string;
}

export interface GitHubPullRequestMergedEvent extends DiscoveredGitHubPullRequest {
  readonly title?: string | undefined;
  readonly headSha?: string | undefined;
  readonly headBranch?: string | undefined;
  readonly mergedAt?: string | undefined;
}

export function extractGitHubPullRequests(text: string): DiscoveredGitHubPullRequest[] {
  const results = new Map<string, DiscoveredGitHubPullRequest>();
  const matcher = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/gi;
  for (const match of text.matchAll(matcher)) {
    const owner = match[1];
    const repo = match[2];
    const numberText = match[3];
    if (owner === undefined || repo === undefined || numberText === undefined) continue;
    const number = Number(numberText);
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    const externalId = `${owner}/${repo}#${number}`;
    results.set(externalId, {
      owner,
      repo,
      number,
      url: `https://github.com/${owner}/${repo}/pull/${number}`,
      externalId,
    });
  }
  return [...results.values()];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function nestedString(value: unknown, path: readonly string[]): string | undefined {
  let cursor: unknown = value;
  for (const part of path) {
    cursor = record(cursor)?.[part];
  }
  return typeof cursor === "string" && cursor.trim().length > 0 ? cursor : undefined;
}

function nestedNumber(value: unknown, path: readonly string[]): number | undefined {
  let cursor: unknown = value;
  for (const part of path) {
    cursor = record(cursor)?.[part];
  }
  return typeof cursor === "number" && Number.isSafeInteger(cursor) ? cursor : undefined;
}

export function parseGitHubPullRequestMergedEvent(
  eventName: string,
  payload: unknown,
): GitHubPullRequestMergedEvent | null {
  if (eventName !== "pull_request") {
    return null;
  }
  if (record(record(payload)?.pull_request)?.merged !== true) {
    return null;
  }

  const owner = nestedString(payload, ["repository", "owner", "login"]);
  const repo = nestedString(payload, ["repository", "name"]);
  const number = nestedNumber(payload, ["pull_request", "number"]);
  const htmlUrl = nestedString(payload, ["pull_request", "html_url"]);
  if (!owner || !repo || number === undefined || !htmlUrl) {
    return null;
  }

  return {
    owner,
    repo,
    number,
    url: htmlUrl,
    externalId: `${owner}/${repo}#${number}`,
    ...(nestedString(payload, ["pull_request", "title"]) !== undefined
      ? { title: nestedString(payload, ["pull_request", "title"]) }
      : {}),
    ...(nestedString(payload, ["pull_request", "head", "sha"]) !== undefined
      ? { headSha: nestedString(payload, ["pull_request", "head", "sha"]) }
      : {}),
    ...(nestedString(payload, ["pull_request", "head", "ref"]) !== undefined
      ? { headBranch: nestedString(payload, ["pull_request", "head", "ref"]) }
      : {}),
    ...(nestedString(payload, ["pull_request", "merged_at"]) !== undefined
      ? { mergedAt: nestedString(payload, ["pull_request", "merged_at"]) }
      : {}),
  };
}
