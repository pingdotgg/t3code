import {
  parseFigmaDesignUrl,
  parseGitHubIssueUrl,
  parseGitHubPullRequestUrl,
  parseJiraBrowseUrl,
} from "@t3tools/shared/composerContextExternalLinks";

export type ExactPullRequestRef = {
  readonly number: number;
  readonly repository?: string;
};

export type ExactIssueRef = {
  readonly number: number;
  readonly repository?: string;
  readonly url?: string;
};

const NUMBER_ONLY = /^#?(\d+)$/u;
const REPO_NUMBER = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/u;
const JIRA_KEY = /^([A-Z][A-Z0-9]+-\d+)$/u;
const FIGMA_FILE_KEY = /^([A-Za-z0-9]{10,128})$/u;

/** Exact PR presence: `#42`, `42`, `owner/repo#42`, or a GitHub PR URL. */
export function parseExactPullRequestQuery(query: string): ExactPullRequestRef | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;

  const fromUrl = parseGitHubPullRequestUrl(trimmed);
  if (fromUrl) {
    return { number: fromUrl.number, repository: fromUrl.repository };
  }

  const repoNumber = REPO_NUMBER.exec(trimmed);
  if (repoNumber) {
    return { number: Number(repoNumber[2]), repository: repoNumber[1]!.toLowerCase() };
  }

  const numberOnly = NUMBER_ONLY.exec(trimmed);
  if (numberOnly) {
    const number = Number(numberOnly[1]);
    return Number.isSafeInteger(number) && number > 0 ? { number } : null;
  }

  return null;
}

/** Exact issue presence: `#42`, `42`, `owner/repo#42`, or a GitHub issue URL. */
export function parseExactIssueQuery(query: string): ExactIssueRef | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;

  const fromUrl = parseGitHubIssueUrl(trimmed);
  if (fromUrl) {
    return {
      number: fromUrl.number,
      repository: fromUrl.repository,
      url: fromUrl.url,
    };
  }

  const repoNumber = REPO_NUMBER.exec(trimmed);
  if (repoNumber) {
    return { number: Number(repoNumber[2]), repository: repoNumber[1]!.toLowerCase() };
  }

  const numberOnly = NUMBER_ONLY.exec(trimmed);
  if (numberOnly) {
    const number = Number(numberOnly[1]);
    return Number.isSafeInteger(number) && number > 0 ? { number } : null;
  }

  return null;
}

/** Exact Jira presence: `PROJ-123` or a browse URL. */
export function parseExactJiraQuery(query: string): string | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;

  const fromUrl = parseJiraBrowseUrl(trimmed);
  if (fromUrl) return fromUrl.key;

  const key = JIRA_KEY.exec(trimmed);
  return key?.[1] ?? null;
}

/** Exact Figma presence: a file key or design/file URL. */
export function parseExactFigmaQuery(query: string): string | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;

  const fromUrl = parseFigmaDesignUrl(trimmed);
  if (fromUrl) return fromUrl.fileKey;

  const key = FIGMA_FILE_KEY.exec(trimmed);
  return key?.[1] ?? null;
}
