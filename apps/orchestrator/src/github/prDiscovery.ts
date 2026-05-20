export interface DiscoveredGitHubPullRequest {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly externalId: string;
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
