export interface GitHubPullRequestUrlParts {
  owner: string;
  repo: string;
  number: string;
}

const GITHUB_PULL_REQUEST_URL_PATTERN =
  /^https:\/\/github\.com\/(?<owner>[^/\s]+)\/(?<repo>[^/\s]+)\/pull\/(?<number>\d+)(?:[/?#|][^\s)\]}>|]*)?$/i;

export function parseGitHubPullRequestUrl(input: string): GitHubPullRequestUrlParts | null {
  const trimmed = input.trim().replace(/^</, "").replace(/>$/, "");
  const slackPipeIndex = trimmed.indexOf("|");
  const candidate = slackPipeIndex === -1 ? trimmed : trimmed.slice(0, slackPipeIndex);
  const match = GITHUB_PULL_REQUEST_URL_PATTERN.exec(candidate);
  const owner = match?.groups?.owner;
  const repo = match?.groups?.repo;
  const number = match?.groups?.number;
  if (!owner || !repo || !number) {
    return null;
  }

  return { owner, repo, number };
}

export function buildGitHubPullRequestUrl(input: GitHubPullRequestUrlParts): string {
  return `https://github.com/${input.owner}/${input.repo}/pull/${input.number}`;
}

export function normalizeGitHubPullRequestUrl(input: string): string | null {
  const parsed = parseGitHubPullRequestUrl(input);
  return parsed ? buildGitHubPullRequestUrl(parsed) : null;
}
