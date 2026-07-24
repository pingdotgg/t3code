const GITHUB_ISSUE_URL_PATTERN =
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)(?:[/?#].*)?$/i;
const ISSUE_NUMBER_PATTERN = /^#?(\d+)$/;

export function parseIssueReference(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (GITHUB_ISSUE_URL_PATTERN.test(trimmed)) {
    return trimmed;
  }

  const numberMatch = ISSUE_NUMBER_PATTERN.exec(trimmed);
  return numberMatch?.[1] ?? null;
}
