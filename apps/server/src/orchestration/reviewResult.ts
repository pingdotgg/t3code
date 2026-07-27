import {
  ReviewModelOutput,
  type ReviewFinding,
  type ReviewResult,
  type ReviewSnapshot,
} from "@t3tools/contracts";
import { extractReviewOutputJson } from "@t3tools/shared/workflows/reviewOutput";
import { Schema } from "effect";

type ChangedLines = ReadonlyMap<
  string,
  Readonly<{
    readonly newLines: ReadonlySet<number>;
    readonly oldLines: ReadonlySet<number>;
    readonly newHunkLines: ReadonlySet<number>;
    readonly oldHunkLines: ReadonlySet<number>;
  }>
>;
const decodeReviewModelOutput = Schema.decodeUnknownSync(ReviewModelOutput);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rangeOverlaps(
  lines: ReadonlySet<number> | undefined,
  startLine: number,
  endLine: number,
): boolean {
  if (!lines) return false;
  for (let line = startLine; line <= endLine; line += 1) {
    if (lines.has(line)) return true;
  }
  return false;
}

function inferSide(
  changedLines: ChangedLines,
  path: string,
  startLine: number,
  endLine: number,
): "new" | "old" {
  const lines = changedLines.get(path);
  if (rangeOverlaps(lines?.newLines, startLine, endLine)) return "new";
  if (rangeOverlaps(lines?.oldLines, startLine, endLine)) return "old";
  // Reviewers cite line numbers read from the file, so a finding often lands on
  // unchanged context inside a hunk. Anchor it to whichever side renders it.
  if (rangeOverlaps(lines?.newHunkLines, startLine, endLine)) return "new";
  if (rangeOverlaps(lines?.oldHunkLines, startLine, endLine)) return "old";
  return "new";
}

const PRIORITY_BY_LEVEL = ["critical", "high", "medium", "low"] as const;

// Reviewers sometimes report a path that does not suffix-match the diff path
// (bare file name, repo-relative path from a different root). Fall back to a
// unique file-name match so the finding is not silently discarded.
function resolveFindingPath(paths: readonly string[], reported: string): string | null {
  const direct = paths.find(
    (candidate) => reported === candidate || reported.endsWith(`/${candidate}`),
  );
  if (direct) return direct;
  const name = reported.split("/").at(-1);
  if (!name) return null;
  const matches = paths.filter((candidate) => candidate === name || candidate.endsWith(`/${name}`));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function resolvePriority(value: Record<string, unknown>): ReviewFinding["priority"] {
  if (typeof value.priority === "number" && value.priority >= 0 && value.priority <= 3) {
    return PRIORITY_BY_LEVEL[value.priority] ?? "medium";
  }
  const tagged = typeof value.title === "string" ? /^\[P([0-3])\]/.exec(value.title) : null;
  return tagged ? (PRIORITY_BY_LEVEL[Number(tagged[1])] ?? "medium") : "medium";
}

function resolveConfidence(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function normalizeCodexOutput(decoded: unknown, changedLines: ChangedLines): unknown {
  if (
    !isRecord(decoded) ||
    !Array.isArray(decoded.findings) ||
    (decoded.overall_correctness !== "patch is correct" &&
      decoded.overall_correctness !== "patch is incorrect")
  ) {
    return null;
  }

  const paths = [...changedLines.keys()];
  const summary =
    typeof decoded.overall_explanation === "string" && decoded.overall_explanation.trim().length > 0
      ? decoded.overall_explanation
      : decoded.overall_correctness === "patch is incorrect"
        ? "The reviewer reported issues without a summary."
        : "The reviewer reported no issues.";
  return {
    findings: decoded.findings.flatMap((value, index) => {
      if (!isRecord(value) || !isRecord(value.code_location)) return [];
      const location = value.code_location;
      const range = isRecord(location.line_range) ? location.line_range : {};
      const reportedPath =
        typeof location.absolute_file_path === "string" ? location.absolute_file_path : "";
      const path = resolveFindingPath(paths, reportedPath);
      const title =
        typeof value.title === "string" ? value.title.replace(/^\[P[0-3]\]\s*/, "").trim() : "";
      const body = typeof value.body === "string" ? value.body.trim() : "";
      // Reject per finding rather than per review: one malformed entry must not
      // discard the findings that decode cleanly.
      if (
        path === null ||
        title.length === 0 ||
        body.length === 0 ||
        typeof range.start !== "number" ||
        typeof range.end !== "number" ||
        !Number.isInteger(range.start) ||
        !Number.isInteger(range.end)
      ) {
        return [];
      }
      const startLine = Math.max(1, Math.min(range.start, range.end));
      const endLine = Math.max(startLine, range.start, range.end);
      return [
        {
          id: `finding-${index + 1}`,
          priority: resolvePriority(value),
          title,
          body,
          confidence: resolveConfidence(value.confidence_score),
          location: {
            path,
            side: inferSide(changedLines, path, startLine, endLine),
            startLine,
            endLine,
          },
        },
      ];
    }),
    verdict: decoded.overall_correctness === "patch is incorrect" ? "request-changes" : "approve",
    summary,
  };
}

function pathsFromDiff(diff: string): ChangedLines {
  const linesByPath = new Map<
    string,
    {
      newLines: Set<number>;
      oldLines: Set<number>;
      newHunkLines: Set<number>;
      oldHunkLines: Set<number>;
    }
  >();
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let activePath: string | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  const linesFor = (path: string) => {
    const existing = linesByPath.get(path);
    if (existing) return existing;
    const created = {
      newLines: new Set<number>(),
      oldLines: new Set<number>(),
      newHunkLines: new Set<number>(),
      oldHunkLines: new Set<number>(),
    };
    linesByPath.set(path, created);
    return created;
  };
  const diffPath = (line: string, prefix: "--- " | "+++ ") => {
    const value = line.slice(prefix.length).split("\t", 1)[0] ?? "";
    if (value === "/dev/null") return null;
    return value.replace(/^[ab]\//, "");
  };

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      oldPath = null;
      newPath = null;
      activePath = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("--- ")) {
      oldPath = diffPath(line, "--- ");
      continue;
    }
    if (line.startsWith("+++ ")) {
      newPath = diffPath(line, "+++ ");
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      activePath = newPath ?? oldPath;
      oldLine = Number.parseInt(hunk[1] ?? "0", 10);
      newLine = Number.parseInt(hunk[3] ?? "0", 10);
      inHunk = activePath !== null;
      continue;
    }
    if (!inHunk || activePath === null || line.startsWith("\\")) continue;

    const changed = linesFor(activePath);
    if (line.startsWith("+")) {
      changed.newLines.add(newLine);
      changed.newHunkLines.add(newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      changed.oldLines.add(oldLine);
      changed.oldHunkLines.add(oldLine);
      oldLine += 1;
    } else {
      changed.oldHunkLines.add(oldLine);
      changed.newHunkLines.add(newLine);
      oldLine += 1;
      newLine += 1;
    }
  }

  return linesByPath;
}

function invalid(snapshot: ReviewSnapshot, issues: readonly string[]): ReviewResult {
  return {
    status: "invalid-output",
    snapshot,
    issues: [...issues],
  };
}

function dedupeFindings(findings: readonly ReviewFinding[]): readonly ReviewFinding[] {
  const seenIds = new Set<string>();
  return findings.filter((finding) => {
    if (seenIds.has(finding.id)) return false;
    seenIds.add(finding.id);
    return true;
  });
}

export function parseReviewResult(input: {
  readonly output: string;
  readonly snapshot: ReviewSnapshot;
}): ReviewResult {
  const decoded = extractReviewOutputJson(input.output);
  if (decoded.status === "invalid") {
    return invalid(input.snapshot, [decoded.issue]);
  }

  const changedLines = pathsFromDiff(input.snapshot.diff);
  const reportedFindingCount =
    isRecord(decoded.value) && Array.isArray(decoded.value.findings)
      ? decoded.value.findings.length
      : 0;
  let output: typeof ReviewModelOutput.Type;
  try {
    output = decodeReviewModelOutput(normalizeCodexOutput(decoded.value, changedLines));
  } catch {
    return invalid(input.snapshot, ["Reviewer output did not match the required review schema."]);
  }

  // Findings are dropped only when they name a file outside the reviewed diff.
  // Line ranges that land on unchanged context stay visible: reviewers cite
  // file line numbers, so requiring an exact changed-line hit silently hid
  // real findings.
  const findings = dedupeFindings(output.findings);
  if (reportedFindingCount > 0 && findings.length === 0) {
    return invalid(input.snapshot, [
      "Reviewer findings did not reference any file in the reviewed diff.",
    ]);
  }
  return {
    status: "parsed",
    snapshot: input.snapshot,
    findings,
    verdict: output.verdict,
    summary: output.summary,
  };
}
