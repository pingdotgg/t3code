const GITHUB_PULL_REQUEST_URL_PATTERN =
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)(?:[/?#].*)?$/i;
const GITLAB_MERGE_REQUEST_URL_PATTERN =
  /^https:\/\/[^/\s]+\/(?:[^/\s]+\/)+(?:-\/)?merge_requests\/(\d+)(?:[/?#].*)?$/i;
const PULL_REQUEST_NUMBER_PATTERN = /^#?(\d+)$/;

export function parsePullRequestReference(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const githubUrlMatch = GITHUB_PULL_REQUEST_URL_PATTERN.exec(trimmed);
  if (githubUrlMatch?.[1]) {
    return trimmed;
  }

  const gitlabUrlMatch = GITLAB_MERGE_REQUEST_URL_PATTERN.exec(trimmed);
  if (gitlabUrlMatch?.[1]) {
    return trimmed;
  }

  const numberMatch = PULL_REQUEST_NUMBER_PATTERN.exec(trimmed);
  if (numberMatch?.[1]) {
    return trimmed.startsWith("#") ? trimmed : numberMatch[1];
  }

  return null;
}
