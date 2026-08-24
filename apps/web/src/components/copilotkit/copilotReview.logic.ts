export const MAX_REVIEW_DIFF_CHARS = 70_000;

export interface ReviewDiffSource {
  readonly title: string;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly diff: string;
  readonly truncated: boolean;
}

export interface ReviewDiffFileSummary {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface ReviewDiffContext {
  readonly summary: {
    readonly changedFiles: number;
    readonly additions: number;
    readonly deletions: number;
    readonly sourceCount: number;
    readonly truncated: boolean;
  };
  readonly files: ReadonlyArray<ReviewDiffFileSummary>;
  readonly diff: string;
}

export interface ReviewFinding {
  readonly id: string;
  readonly severity: "critical" | "high" | "medium" | "low";
  readonly title: string;
  readonly file: string;
  readonly line?: number | undefined;
  readonly explanation: string;
  readonly suggestedFix: string;
}

function normalizedDiffPath(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "/dev/null") return null;
  return trimmed.replace(/^[ab]\//, "");
}

export function summarizeUnifiedDiff(diff: string): ReadonlyArray<ReviewDiffFileSummary> {
  const byPath = new Map<string, { path: string; additions: number; deletions: number }>();
  let current: { path: string; additions: number; deletions: number } | null = null;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      const path = match?.[2] ? normalizedDiffPath(match[2]) : null;
      if (path === null) {
        current = null;
        continue;
      }
      current = byPath.get(path) ?? { path, additions: 0, deletions: 0 };
      byPath.set(path, current);
      continue;
    }

    if (current === null) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) current.additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) current.deletions += 1;
  }

  return [...byPath.values()];
}

export function buildReviewDiffContext(
  sources: ReadonlyArray<ReviewDiffSource>,
  maxChars = MAX_REVIEW_DIFF_CHARS,
): ReviewDiffContext {
  const availableSources = sources.filter((source) => source.diff.trim().length > 0);
  const fullDiff = availableSources
    .map(
      (source) =>
        `### ${source.title} (${source.baseRef ?? "working tree"} -> ${source.headRef ?? "current files"})\n${source.diff}`,
    )
    .join("\n\n");
  const files = summarizeUnifiedDiff(fullDiff);
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  const clipped = fullDiff.length > maxChars;
  const diff = clipped
    ? `${fullDiff.slice(0, maxChars)}\n\n[Diff context clipped at ${maxChars.toLocaleString()} characters]`
    : fullDiff;

  return {
    summary: {
      changedFiles: files.length,
      additions,
      deletions,
      sourceCount: availableSources.length,
      truncated: clipped || availableSources.some((source) => source.truncated),
    },
    files,
    diff,
  };
}

export function safeWorkspaceRelativePath(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/^[ab]\//, "")
    .replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    return null;
  }

  const segments = normalized.split("/");
  return segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ? null
    : normalized;
}

export function reviewApprovalSignature(
  findings: ReadonlyArray<ReviewFinding>,
  verification: ReadonlyArray<string>,
): string {
  return JSON.stringify({
    findings: findings.map(({ id, severity, title, file, line, explanation, suggestedFix }) => ({
      id,
      severity,
      title,
      file,
      line: line ?? null,
      explanation,
      suggestedFix,
    })),
    verification,
  });
}

export function buildApprovedFixPrompt(
  findings: ReadonlyArray<ReviewFinding>,
  verification: ReadonlyArray<string>,
): string {
  const findingText = findings
    .map(
      (finding, index) =>
        `${index + 1}. [${finding.severity.toUpperCase()}] ${finding.title}\n` +
        `   File: ${finding.file}${finding.line ? `:${finding.line}` : ""}\n` +
        `   Why: ${finding.explanation}\n` +
        `   Requested fix: ${finding.suggestedFix}`,
    )
    .join("\n\n");
  const verificationText =
    verification.length > 0
      ? verification.map((command) => `- ${command}`).join("\n")
      : "- Run the smallest relevant tests and typecheck for the files you change.";

  return `Implement the approved PR review fixes below.

Inspect the current branch diff and the referenced files before editing. Make only the approved changes, preserve unrelated work, and follow the repository instructions.

${findingText}

Verification requested:
${verificationText}

After editing, run the targeted verification and summarize exactly what changed and any remaining risk.`;
}
