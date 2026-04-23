export interface DiffLine {
  type: "context" | "addition" | "deletion" | "separator";
  content: string;
}

export interface DiffStats {
  additions: number;
  deletions: number;
}

export interface InlineDiffHunk {
  filePath: string;
  operation: "edit" | "write";
  lines: ReadonlyArray<DiffLine>;
  fullLines: ReadonlyArray<DiffLine>;
  truncated: boolean;
  stats: DiffStats;
  patch: string;
}

const MAX_DIFF_LINES = 40;
const MAX_LCS_INPUT_LINES = 200;
const CONTEXT_RADIUS = 3;

const EDIT_TOOL_NAMES = new Set([
  "edit",
  "Edit",
  "MultiEdit",
  "multiedit",
  "file_edit",
  "EditTool",
  "str_replace_editor",
  "str_replace",
  "str-replace",
  "strReplace",
  "search_replace",
  "searchReplace",
]);

const WRITE_TOOL_NAMES = new Set([
  "write",
  "Write",
  "file_write",
  "WriteTool",
  "create_file",
  "CreateFile",
  "create",
]);

// apply_patch tools embed the file path inside the patch text itself via
// `*** Update File: <path>` / `*** Add File: <path>` / `*** Delete File: <path>`
// markers — OpenCode, Codex, and Cursor's ACP patch extension all use this
// format. Input key is usually `patchText` (OpenCode) but some providers use
// `patch`, `diff`, or `input`.
const PATCH_TOOL_NAMES = new Set([
  "apply_patch",
  "ApplyPatch",
  "applyPatch",
  "patch",
  "Patch",
  "apply-patch",
]);

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  const n = oldLines.length;
  const m = newLines.length;

  if (n === 0 && m === 0) return [];

  if (n === 0) {
    return newLines.map((line) => ({ type: "addition" as const, content: line }));
  }
  if (m === 0) {
    return oldLines.map((line) => ({ type: "deletion" as const, content: line }));
  }

  if (n > MAX_LCS_INPUT_LINES || m > MAX_LCS_INPUT_LINES) {
    return [
      ...oldLines.map((line) => ({ type: "deletion" as const, content: line })),
      ...newLines.map((line) => ({ type: "addition" as const, content: line })),
    ];
  }

  const lcs = computeLCS(oldLines, newLines);

  const result: DiffLine[] = [];
  let oldIdx = 0;
  let newIdx = 0;

  for (const match of lcs) {
    while (oldIdx < match.oldIndex) {
      result.push({ type: "deletion", content: oldLines[oldIdx]! });
      oldIdx++;
    }
    while (newIdx < match.newIndex) {
      result.push({ type: "addition", content: newLines[newIdx]! });
      newIdx++;
    }
    result.push({ type: "context", content: oldLines[oldIdx]! });
    oldIdx++;
    newIdx++;
  }

  while (oldIdx < n) {
    result.push({ type: "deletion", content: oldLines[oldIdx]! });
    oldIdx++;
  }
  while (newIdx < m) {
    result.push({ type: "addition", content: newLines[newIdx]! });
    newIdx++;
  }

  return result;
}

interface LCSMatch {
  oldIndex: number;
  newIndex: number;
}

function computeLCS(oldLines: string[], newLines: string[]): LCSMatch[] {
  const n = oldLines.length;
  const m = newLines.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0) as number[]);

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  const matches: LCSMatch[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      matches.push({ oldIndex: i - 1, newIndex: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      i--;
    } else {
      j--;
    }
  }

  matches.reverse();
  return matches;
}

function trimContext(lines: DiffLine[]): DiffLine[] {
  const changeIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.type !== "context") {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) return lines;

  const keep = new Set<number>();
  for (const idx of changeIndices) {
    keep.add(idx);
    for (let offset = 1; offset <= CONTEXT_RADIUS; offset++) {
      if (idx - offset >= 0) keep.add(idx - offset);
      if (idx + offset < lines.length) keep.add(idx + offset);
    }
  }

  const result: DiffLine[] = [];
  let lastKept = -1;
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i)) {
      if (lastKept !== -1 && i - lastKept > 1) {
        result.push({ type: "separator", content: String(i - lastKept - 1) });
      }
      result.push(lines[i]!);
      lastKept = i;
    }
  }

  return result;
}

function truncateDiffLines(lines: DiffLine[]): {
  lines: ReadonlyArray<DiffLine>;
  fullLines: ReadonlyArray<DiffLine>;
  truncated: boolean;
} {
  if (lines.length <= MAX_DIFF_LINES) {
    return { lines, fullLines: lines, truncated: false };
  }
  return { lines: lines.slice(0, MAX_DIFF_LINES), fullLines: lines, truncated: true };
}

function buildUnifiedPatch(filePath: string, diffLines: DiffLine[], isNewFile: boolean): string {
  if (diffLines.length === 0) return "";

  let oldCount = 0;
  let newCount = 0;
  const bodyLines: string[] = [];

  for (const line of diffLines) {
    switch (line.type) {
      case "context":
        bodyLines.push(` ${line.content}`);
        oldCount++;
        newCount++;
        break;
      case "deletion":
        bodyLines.push(`-${line.content}`);
        oldCount++;
        break;
      case "addition":
        bodyLines.push(`+${line.content}`);
        newCount++;
        break;
    }
  }

  const aPath = isNewFile ? "/dev/null" : `a/${filePath}`;
  const bPath = `b/${filePath}`;
  const oldStart = oldCount > 0 ? 1 : 0;
  const newStart = newCount > 0 ? 1 : 0;

  return [
    `--- ${aPath}`,
    `+++ ${bPath}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...bodyLines,
  ].join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function extractEditHunk(input: Record<string, unknown>): InlineDiffHunk | null {
  const filePath = asString(input.file_path) ?? asString(input.filePath) ?? asString(input.path);
  const oldString = asString(input.old_string) ?? asString(input.old_text);
  const newString = asString(input.new_string) ?? asString(input.new_text);

  if (!filePath || oldString == null || newString == null) return null;

  const rawLines = computeLineDiff(oldString, newString);
  const stats = diffStats(rawLines);
  const trimmed = trimContext(rawLines);
  const { lines, fullLines, truncated } = truncateDiffLines(trimmed);
  const patch = buildUnifiedPatch(filePath, rawLines, false);

  return { filePath, operation: "edit", lines, fullLines, truncated, stats, patch };
}

function extractWriteHunk(input: Record<string, unknown>): InlineDiffHunk | null {
  const filePath = asString(input.file_path) ?? asString(input.filePath) ?? asString(input.path);
  const content = asString(input.content);

  if (!filePath || content == null) return null;

  const contentLines = splitLines(content);
  const rawLines: DiffLine[] = contentLines.map((line) => ({
    type: "addition" as const,
    content: line,
  }));
  const stats: DiffStats = { additions: rawLines.length, deletions: 0 };
  const { lines, fullLines, truncated } = truncateDiffLines(rawLines);
  const patch = buildUnifiedPatch(filePath, rawLines, true);

  return { filePath, operation: "write", lines, fullLines, truncated, stats, patch };
}

/**
 * Parse the `apply_patch` / `patch` tool's patchText format into per-file hunks.
 *
 * Format (OpenCode/Codex/Cursor convention):
 *
 *     *** Begin Patch
 *     *** Update File: path/to/file.ts
 *     @@ ...
 *      context
 *     -removed
 *     +added
 *     *** Add File: path/to/new.ts
 *     +content line 1
 *     +content line 2
 *     *** Delete File: path/to/obsolete.ts
 *     *** End Patch
 */
const PATCH_HEADER_RE = /^\*\*\*\s+(Begin|End)\s+Patch\s*$/i;
const PATCH_FILE_MARKER_RE = /^\*\*\*\s+(Update|Add|Delete)\s+File:\s*(.+?)\s*$/i;

function extractApplyPatchHunks(input: Record<string, unknown>): InlineDiffHunk[] {
  const patchText =
    asString(input.patchText) ??
    asString(input.patch_text) ??
    asString(input.patch) ??
    asString(input.diff) ??
    asString(input.input);
  if (!patchText) return [];

  const hunks: InlineDiffHunk[] = [];
  let currentPath: string | null = null;
  let currentOp: "edit" | "write" | "delete" = "edit";
  let currentLines: DiffLine[] = [];

  const flush = () => {
    if (!currentPath || currentLines.length === 0) return;
    const operation: InlineDiffHunk["operation"] = currentOp === "delete" ? "edit" : currentOp; // delete → show as edit removal
    const stats = diffStats(currentLines);
    const trimmed = currentOp === "write" ? currentLines : trimContext(currentLines);
    const { lines, fullLines, truncated } = truncateDiffLines(trimmed);
    const patch = buildUnifiedPatch(currentPath, currentLines, currentOp === "write");
    hunks.push({ filePath: currentPath, operation, lines, fullLines, truncated, stats, patch });
  };

  for (const rawLine of patchText.split(/\r?\n/)) {
    if (PATCH_HEADER_RE.test(rawLine)) {
      flush();
      currentPath = null;
      currentLines = [];
      continue;
    }
    const markerMatch = rawLine.match(PATCH_FILE_MARKER_RE);
    if (markerMatch) {
      flush();
      const kind = markerMatch[1]?.toLowerCase();
      currentPath = markerMatch[2] ?? null;
      currentOp = kind === "add" ? "write" : kind === "delete" ? "delete" : "edit";
      currentLines = [];
      continue;
    }
    if (!currentPath) continue;
    if (rawLine.startsWith("@@")) continue; // hunk headers — informational only
    if (rawLine.startsWith("+")) {
      currentLines.push({ type: "addition", content: rawLine.slice(1) });
    } else if (rawLine.startsWith("-")) {
      currentLines.push({ type: "deletion", content: rawLine.slice(1) });
    } else if (rawLine.startsWith(" ")) {
      currentLines.push({ type: "context", content: rawLine.slice(1) });
    } else if (rawLine.length > 0) {
      // Raw content for Add File sections (no +/- prefix for new files).
      if (currentOp === "write") {
        currentLines.push({ type: "addition", content: rawLine });
      } else {
        currentLines.push({ type: "context", content: rawLine });
      }
    }
  }
  flush();
  return hunks;
}

export function extractDiffPreviews(payload: Record<string, unknown> | null): InlineDiffHunk[] {
  if (!payload) return [];

  const data = asRecord(payload.data);
  if (!data) return [];

  const toolName = asString(data.toolName);
  const input = asRecord(data.input);

  if (!toolName || !input) return [];

  if (EDIT_TOOL_NAMES.has(toolName)) {
    const hunk = extractEditHunk(input);
    return hunk ? [hunk] : [];
  }

  if (WRITE_TOOL_NAMES.has(toolName)) {
    const hunk = extractWriteHunk(input);
    return hunk ? [hunk] : [];
  }

  if (PATCH_TOOL_NAMES.has(toolName)) {
    return extractApplyPatchHunks(input);
  }

  return [];
}

export function mergeDiffPreviews(
  a: ReadonlyArray<InlineDiffHunk>,
  b: ReadonlyArray<InlineDiffHunk>,
): InlineDiffHunk[] {
  if (a.length === 0) return [...b];
  if (b.length === 0) return [...a];

  const byPath = new Map<string, InlineDiffHunk>();
  for (const hunk of a) {
    byPath.set(hunk.filePath, hunk);
  }
  for (const hunk of b) {
    byPath.set(hunk.filePath, hunk);
  }

  return [...byPath.values()];
}

export function diffStats(lines: ReadonlyArray<DiffLine>): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.type === "addition") additions++;
    if (line.type === "deletion") deletions++;
  }
  return { additions, deletions };
}
