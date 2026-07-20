import {
  ReviewModelOutput,
  type ReviewFinding,
  type ReviewResult,
  type ReviewSnapshot,
} from "@t3tools/contracts";
import { Schema } from "effect";

type ChangedLines = ReadonlyMap<
  string,
  Readonly<{ readonly newLines: ReadonlySet<number>; readonly oldLines: ReadonlySet<number> }>
>;
const decodeReviewModelOutput = Schema.decodeUnknownSync(ReviewModelOutput);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCodexOutput(decoded: unknown, changedLines: ChangedLines): unknown {
  if (
    !isRecord(decoded) ||
    !Array.isArray(decoded.findings) ||
    (decoded.overall_correctness !== "patch is correct" &&
      decoded.overall_correctness !== "patch is incorrect") ||
    typeof decoded.overall_confidence_score !== "number"
  ) {
    return null;
  }

  const paths = [...changedLines.keys()];
  return {
    findings: decoded.findings.flatMap((value, index) => {
      if (!isRecord(value) || !isRecord(value.code_location)) return [];
      const location = value.code_location;
      const range = isRecord(location.line_range) ? location.line_range : {};
      const absolutePath =
        typeof location.absolute_file_path === "string" ? location.absolute_file_path : "";
      const path = paths.find(
        (candidate) => absolutePath === candidate || absolutePath.endsWith(`/${candidate}`),
      );
      const priority =
        value.priority === 0
          ? "critical"
          : value.priority === 1
            ? "high"
            : value.priority === 2
              ? "medium"
              : value.priority === 3
                ? "low"
                : null;
      if (
        !path ||
        !priority ||
        typeof value.title !== "string" ||
        typeof value.body !== "string" ||
        typeof value.confidence_score !== "number"
      ) {
        return [];
      }
      return [
        {
          id: `finding-${index + 1}`,
          priority,
          title: value.title.replace(/^\[P[0-3]\]\s*/, ""),
          body: value.body,
          confidence: value.confidence_score,
          location: {
            path,
            side: "new",
            startLine: range.start,
            endLine: range.end,
          },
        },
      ];
    }),
    verdict: decoded.overall_correctness === "patch is incorrect" ? "request-changes" : "approve",
    summary: decoded.overall_explanation,
  };
}

function pathsFromDiff(diff: string): ChangedLines {
  const linesByPath = new Map<string, { newLines: Set<number>; oldLines: Set<number> }>();
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let activePath: string | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  const linesFor = (path: string) => {
    const existing = linesByPath.get(path);
    if (existing) return existing;
    const created = { newLines: new Set<number>(), oldLines: new Set<number>() };
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
      newLine += 1;
    } else if (line.startsWith("-")) {
      changed.oldLines.add(oldLine);
      oldLine += 1;
    } else {
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

function locationIssues(
  findings: readonly ReviewFinding[],
  changedLines: ChangedLines,
): ReadonlyArray<string> {
  const issues: string[] = [];
  const findingIds = new Set<string>();
  for (const finding of findings) {
    if (findingIds.has(finding.id)) {
      issues.push(`Finding '${finding.id}' has a duplicate id.`);
    }
    findingIds.add(finding.id);

    const lines = changedLines.get(finding.location.path);
    const allowedLines = finding.location.side === "new" ? lines?.newLines : lines?.oldLines;
    let overlapsChangedLine = false;
    for (let line = finding.location.startLine; line <= finding.location.endLine; line += 1) {
      overlapsChangedLine ||= allowedLines?.has(line) ?? false;
    }
    if (!overlapsChangedLine) {
      issues.push(
        `Finding '${finding.id}' does not overlap a changed ${finding.location.side} line in ${finding.location.path}.`,
      );
    }
  }
  return issues;
}

export function parseReviewResult(input: {
  readonly output: string;
  readonly snapshot: ReviewSnapshot;
}): ReviewResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(input.output);
  } catch {
    return invalid(input.snapshot, ["Reviewer output was not valid JSON."]);
  }

  let output: typeof ReviewModelOutput.Type;
  try {
    output = decodeReviewModelOutput(
      normalizeCodexOutput(decoded, pathsFromDiff(input.snapshot.diff)),
    );
  } catch {
    return invalid(input.snapshot, ["Reviewer output did not match the required review schema."]);
  }

  const issues = locationIssues(output.findings, pathsFromDiff(input.snapshot.diff));
  return issues.length > 0
    ? invalid(input.snapshot, issues)
    : {
        status: "parsed",
        snapshot: input.snapshot,
        findings: output.findings,
        verdict: output.verdict,
        summary: output.summary,
      };
}
