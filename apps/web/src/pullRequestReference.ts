const GITHUB_PULL_REQUEST_URL_PATTERN =
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)(?:[/?#].*)?$/i;
const PULL_REQUEST_NUMBER_PATTERN = /^#?(\d+)$/;

export function parsePullRequestReference(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const urlMatch = GITHUB_PULL_REQUEST_URL_PATTERN.exec(trimmed);
  if (urlMatch?.[1]) {
    return trimmed;
  }

  const numberMatch = PULL_REQUEST_NUMBER_PATTERN.exec(trimmed);
  if (numberMatch?.[1]) {
    return trimmed.startsWith("#") ? trimmed : numberMatch[1];
  }

  return null;
}
