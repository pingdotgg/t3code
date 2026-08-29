export const MAX_REVIEW_DIFF_CHUNK_CHARS = 60_000;

export interface ReviewDiffSource {
  readonly kind: "working-tree" | "branch-range";
  readonly title: string;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly diff: string;
  readonly truncated: boolean;
}

export interface ReviewDiffSelection {
  readonly sources: ReadonlyArray<ReviewDiffSource>;
  readonly workingTreeFallback: boolean;
}

export interface ReviewDiffFileSummary {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export interface ReviewDiffChunk {
  readonly index: number;
  readonly title: string;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly files: ReadonlyArray<string>;
  readonly characters: number;
  readonly diff: string;
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
  readonly chunks: ReadonlyArray<ReviewDiffChunk>;
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

export type ReviewVerdict = "ready" | "needs-work" | "blocked";

export type ReviewProgressStage =
  | "mapping"
  | "correctness"
  | "security"
  | "performance"
  | "finalizing";

export interface ReviewProgressItem {
  readonly stage: ReviewProgressStage;
  readonly title: string;
  readonly detail: string;
  readonly files: ReadonlyArray<string>;
}

export interface ReviewSubmission {
  readonly verdict: ReviewVerdict;
  readonly summary: string;
  readonly changedFiles: number;
  readonly additions: number;
  readonly deletions: number;
  readonly findings: ReadonlyArray<ReviewFinding>;
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

export function selectCompleteReviewDiffSources(
  sources: ReadonlyArray<ReviewDiffSource>,
): ReviewDiffSelection {
  const availableSources = sources.filter((source) => source.diff.trim().length > 0);
  if (!availableSources.some((source) => source.truncated)) {
    return { sources, workingTreeFallback: false };
  }

  const completeWorkingTreeSources = availableSources.filter(
    (source) => source.kind === "working-tree" && !source.truncated,
  );
  return completeWorkingTreeSources.length > 0
    ? { sources: completeWorkingTreeSources, workingTreeFallback: true }
    : { sources, workingTreeFallback: false };
}

interface DiffSection {
  readonly diff: string;
  readonly files: ReadonlyArray<string>;
}

function splitAtLineBoundaries(value: string, maxChars: number): ReadonlyArray<string> {
  if (value.length <= maxChars) return [value];

  const parts: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    const proposedEnd = Math.min(offset + maxChars, value.length);
    if (proposedEnd === value.length) {
      parts.push(value.slice(offset));
      break;
    }

    const newline = value.lastIndexOf("\n", proposedEnd - 1);
    const end = newline >= offset ? newline + 1 : proposedEnd;
    parts.push(value.slice(offset, end));
    offset = end;
  }
  return parts;
}

function splitUnifiedDiffIntoSections(diff: string, maxChars: number): ReadonlyArray<DiffSection> {
  const fileStarts = [...diff.matchAll(/^diff --git /gm)].map((match) => match.index);
  const rawSections =
    fileStarts.length === 0
      ? [diff]
      : [
          ...(fileStarts[0]! > 0 ? [diff.slice(0, fileStarts[0])] : []),
          ...fileStarts.map((start, index) =>
            diff.slice(start, fileStarts[index + 1] ?? diff.length),
          ),
        ];

  return rawSections.flatMap((section) => {
    const files = summarizeUnifiedDiff(section).map((file) => file.path);
    return splitAtLineBoundaries(section, maxChars).map((part) => ({ diff: part, files }));
  });
}

function buildSourceChunks(
  source: ReviewDiffSource,
  maxChars: number,
): ReadonlyArray<Omit<ReviewDiffChunk, "index">> {
  const chunks: Array<Omit<ReviewDiffChunk, "index">> = [];
  let diff = "";
  let files = new Set<string>();

  const flush = () => {
    if (diff.length === 0) return;
    chunks.push({
      title: source.title,
      baseRef: source.baseRef,
      headRef: source.headRef,
      files: [...files],
      characters: diff.length,
      diff,
    });
    diff = "";
    files = new Set<string>();
  };

  for (const section of splitUnifiedDiffIntoSections(source.diff, maxChars)) {
    if (diff.length > 0 && diff.length + section.diff.length > maxChars) flush();
    diff += section.diff;
    for (const file of section.files) files.add(file);
  }
  flush();
  return chunks;
}

export function buildReviewDiffContext(
  sources: ReadonlyArray<ReviewDiffSource>,
  maxChars = MAX_REVIEW_DIFF_CHUNK_CHARS,
): ReviewDiffContext {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new Error("Review diff chunk size must be a positive integer.");
  }
  const availableSources = sources.filter((source) => source.diff.trim().length > 0);
  const fullDiff = availableSources.map((source) => source.diff).join("\n");
  const files = summarizeUnifiedDiff(fullDiff);
  const additions = files.reduce((total, file) => total + file.additions, 0);
  const deletions = files.reduce((total, file) => total + file.deletions, 0);
  const chunks = availableSources
    .flatMap((source) => buildSourceChunks(source, maxChars))
    .map((chunk, index) => ({ ...chunk, index: index + 1 }));

  return {
    summary: {
      changedFiles: files.length,
      additions,
      deletions,
      sourceCount: availableSources.length,
      truncated: availableSources.some((source) => source.truncated),
    },
    files,
    chunks,
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

export function upsertReviewProgress(
  items: ReadonlyArray<ReviewProgressItem>,
  next: ReviewProgressItem,
): ReadonlyArray<ReviewProgressItem> {
  const existingIndex = items.findIndex((item) => item.stage === next.stage);
  if (existingIndex === -1) return [...items, next];
  return items.map((item, index) => (index === existingIndex ? next : item));
}

export function reviewSubmissionProblem(
  context: ReviewDiffContext,
  submission: ReviewSubmission,
): string | null {
  const { summary } = context;
  if (
    submission.changedFiles !== summary.changedFiles ||
    submission.additions !== summary.additions ||
    submission.deletions !== summary.deletions
  ) {
    return "Review totals do not match the inspected diff.";
  }

  const inspectedPaths = new Set(context.files.map((file) => file.path));
  for (const finding of submission.findings) {
    const path = safeWorkspaceRelativePath(finding.file);
    if (path === null || !inspectedPaths.has(path)) {
      return `Finding '${finding.id}' does not point to a file in the inspected diff.`;
    }
  }

  return null;
}
