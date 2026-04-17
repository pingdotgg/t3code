import type { GitHubPullRequestTextExample } from "./Services/GitHubCli.ts";
import { limitSection } from "./Utils.ts";

export const COMMIT_STYLE_EXAMPLE_LIMIT = 10;
export const PR_STYLE_EXAMPLE_LIMIT = 4;

const PR_BODY_EXAMPLE_MAX_CHARS = 1_200;

function dedupeStrings(values: ReadonlyArray<string>, limit: number): ReadonlyArray<string> {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    deduped.push(trimmed);
    if (deduped.length >= limit) {
      break;
    }
  }

  return deduped;
}

function dedupePullRequestExamples(
  values: ReadonlyArray<GitHubPullRequestTextExample>,
  limit: number,
): ReadonlyArray<GitHubPullRequestTextExample> {
  const deduped: GitHubPullRequestTextExample[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const title = value.title.trim();
    const body = value.body.trim();
    if (title.length === 0) {
      continue;
    }

    const key = `${title}\n---\n${body}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push({ title, body });
    if (deduped.length >= limit) {
      break;
    }
  }

  return deduped;
}

function formatCommitSubjectSection(label: string, subjects: ReadonlyArray<string>): string[] {
  if (subjects.length === 0) {
    return [];
  }

  return [label, ...subjects.map((subject) => `- ${subject}`)];
}

function formatPullRequestExampleSection(
  label: string,
  examples: ReadonlyArray<GitHubPullRequestTextExample>,
): string[] {
  if (examples.length === 0) {
    return [];
  }

  const lines: string[] = [label];
  for (const [index, example] of examples.entries()) {
    lines.push(`${index + 1}. Title: ${example.title}`);
    lines.push(
      `   Body:\n${limitSection(example.body.length > 0 ? example.body : "(empty body)", PR_BODY_EXAMPLE_MAX_CHARS)}`,
    );
  }
  return lines;
}

export function buildCommitStyleGuidance(input: {
  authorCommitSubjects: ReadonlyArray<string>;
  repositoryCommitSubjects: ReadonlyArray<string>;
}): string {
  const authorCommitSubjects = dedupeStrings(
    input.authorCommitSubjects,
    COMMIT_STYLE_EXAMPLE_LIMIT,
  );
  const repositoryCommitSubjects = dedupeStrings(
    input.repositoryCommitSubjects,
    COMMIT_STYLE_EXAMPLE_LIMIT,
  );

  if (authorCommitSubjects.length === 0 && repositoryCommitSubjects.length === 0) {
    return [
      "Commit style guidance:",
      "- No recent commit subjects are available from this author or repository.",
      "- Default to Conventional Commits: type(scope): summary",
      "- Common Conventional Commit types include feat, fix, docs, refactor, perf, test, chore, ci, build, and revert",
    ].join("\n");
  }

  const lines = [
    "Commit style guidance:",
    authorCommitSubjects.length > 0
      ? "- Prefer the current author's own recent commit style when examples are available."
      : "- Follow the dominant repository commit style shown below.",
    "- Common styles to recognize include Conventional Commits, emoji/gitmoji prefixes, emoji + conventional hybrids, and plain imperative summaries.",
    "- Ignore trailing PR references like (#123); they are merge metadata, not something to invent.",
    "- If the examples are mixed or unclear, default to Conventional Commits.",
  ];

  lines.push(
    ...formatCommitSubjectSection(
      authorCommitSubjects.length > 0
        ? "Current author's recent commit subjects:"
        : "Recent repository commit subjects:",
      authorCommitSubjects.length > 0 ? authorCommitSubjects : repositoryCommitSubjects,
    ),
  );

  return lines.join("\n");
}

export interface PullRequestStyleGuidance {
  readonly guidance: string;
  readonly useDefaultTemplate: boolean;
}

export function buildPrStyleGuidance(input: {
  authorPullRequests: ReadonlyArray<GitHubPullRequestTextExample>;
  repositoryPullRequests: ReadonlyArray<GitHubPullRequestTextExample>;
  authorCommitSubjects: ReadonlyArray<string>;
  repositoryCommitSubjects: ReadonlyArray<string>;
}): PullRequestStyleGuidance {
  const authorPullRequests = dedupePullRequestExamples(
    input.authorPullRequests,
    PR_STYLE_EXAMPLE_LIMIT,
  );
  const repositoryPullRequests = dedupePullRequestExamples(
    input.repositoryPullRequests,
    PR_STYLE_EXAMPLE_LIMIT,
  );
  const authorCommitSubjects = dedupeStrings(
    input.authorCommitSubjects,
    COMMIT_STYLE_EXAMPLE_LIMIT,
  );
  const repositoryCommitSubjects = dedupeStrings(
    input.repositoryCommitSubjects,
    COMMIT_STYLE_EXAMPLE_LIMIT,
  );
  const preferredPullRequests =
    authorPullRequests.length > 0 ? authorPullRequests : repositoryPullRequests;
  const preferredCommitSubjects =
    authorCommitSubjects.length > 0 ? authorCommitSubjects : repositoryCommitSubjects;
  const useDefaultTemplate = preferredPullRequests.length === 0;

  if (preferredPullRequests.length === 0 && preferredCommitSubjects.length === 0) {
    return {
      useDefaultTemplate: true,
      guidance: [
        "PR style guidance:",
        "- No recent pull request examples are available from this author or repository.",
        "- Default the PR title to Conventional Commits: type(scope): summary",
      ].join("\n"),
    };
  }

  const lines = [
    "PR style guidance:",
    authorPullRequests.length > 0
      ? "- Prefer the current author's own recent pull request style when examples are available."
      : repositoryPullRequests.length > 0
        ? "- Follow the dominant repository pull request style shown below."
        : "- No pull request body examples are available, so infer the title style from recent commit subjects.",
    "- Match the title style, body tone, and body structure shown in the examples when they exist.",
    "- Do not invent PR numbers, issue numbers, or ticket IDs just because examples contain them.",
    ...(useDefaultTemplate
      ? ["- No PR body examples are available, so use the default Summary/Testing body template."]
      : ["- Do not force headings or sections that are absent from the examples."]),
  ];

  lines.push(
    ...formatPullRequestExampleSection(
      authorPullRequests.length > 0
        ? "Current author's recent pull requests:"
        : "Recent repository pull requests:",
      preferredPullRequests,
    ),
  );
  lines.push(
    ...formatCommitSubjectSection(
      authorCommitSubjects.length > 0
        ? "Current author's recent commit subjects:"
        : "Recent repository commit subjects:",
      preferredCommitSubjects,
    ),
  );

  return {
    guidance: lines.join("\n"),
    useDefaultTemplate,
  };
}
