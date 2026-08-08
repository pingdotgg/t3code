/**
 * Vendored Aether tool-display file-change parsing.
 *
 * Self-contained port of `parseFileChanges` / `fileChangeDiff` (and the
 * helpers they need) from the Aether monorepo's
 * `packages/tool-display/src/parse.ts`, plus the two diff-engine entries they
 * depend on (`diffLines`, `parseUnifiedDiff`) from
 * `packages/tool-display/src/diff.ts`. The Aether-only `DiffLine` import
 * (`@aether/domain-types`) is inlined as a local type. See the README in this
 * directory for the sync recipe.
 *
 * The parsers turn a tool message's opaque `input` / `result` payload (both
 * untrusted JSON) into trusted shapes; each returns `null`/empty when the
 * payload does not match so the caller falls back to a generic rendering
 * VISIBLY — never a silent blank.
 *
 * @module provider/Layers/aether/vendored/toolDisplay
 */

// The opaque input map for a tool call.
export type ToolInput = { [key: string]: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A trimmed non-empty string at any of the given keys, else undefined.
function readString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

// A raw string (may be empty) at any of the given keys, else undefined. Content
// bodies must not be trimmed — leading whitespace is significant in diffs/code.
function readText(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function tryJson(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

const PATH_KEYS = ["path", "file_path", "filePath", "file", "filename", "notebook_path"];

// ---------------------------------------------------------------------------
// file_change (diff)
// ---------------------------------------------------------------------------

// A single edited file. Exactly one of (oldText+newText) | diff carries the
// change; `path` may be absent for a bare unified diff.
export type FileChange = {
  path: string | null;
  oldText: string | null;
  newText: string | null;
  diff: string | null;
};

function looksLikeUnifiedDiff(value: string): boolean {
  return (
    value.startsWith("diff --git ") ||
    value.startsWith("--- ") ||
    value.startsWith("+++ ") ||
    value.startsWith("@@ ") ||
    value.includes("\n@@ ")
  );
}

type ChangeOp = "create" | "delete" | "modify";

// The operation for a change, read from the normalized `op` (codex client shape)
// or the raw `kind.type` (raw provider shape). Anything else → "modify".
function readChangeOp(record: Record<string, unknown>): ChangeOp {
  const kind = isRecord(record["kind"]) ? record["kind"] : null;
  const raw = (
    readString(record, "op") ??
    (kind ? readString(kind, "type") : undefined) ??
    ""
  ).toLowerCase();
  switch (raw) {
    case "create":
    case "created":
    case "add":
    case "added":
    case "new":
      return "create";
    case "delete":
    case "deleted":
    case "remove":
    case "removed":
      return "delete";
    default:
      return "modify";
  }
}

function normalizeChange(record: Record<string, unknown>): FileChange | null {
  const path = readString(record, ...PATH_KEYS) ?? null;
  const op = readChangeOp(record);
  const oldText = readText(record, "oldContent", "old_content", "before", "old_string") ?? null;
  const newText =
    readText(record, "newContent", "new_content", "after", "content", "new_string") ?? null;
  const rawDiff = readText(record, "diff") ?? null;
  // A `diff` field that isn't a unified diff and has no old/new pair is a plain
  // file body. Its DIRECTION depends on the op: a DELETE body is the OLD file
  // content (renders as red removals); an add/modify body is NEW content.
  const plainBody =
    rawDiff !== null && oldText === null && newText === null && !looksLikeUnifiedDiff(rawDiff)
      ? rawDiff
      : null;
  const diff = plainBody !== null ? null : rawDiff;
  const resolvedOld = oldText ?? (plainBody !== null && op === "delete" ? plainBody : null);
  const resolvedNew = newText ?? (plainBody !== null && op !== "delete" ? plainBody : null);

  if (path === null && resolvedOld === null && resolvedNew === null && diff === null) return null;
  return { path, oldText: resolvedOld, newText: resolvedNew, diff };
}

// True when a change carries something the diff view can actually render
// (old/new text or a diff), not merely a path/op stub.
function hasDiffContent(change: FileChange): boolean {
  return change.oldText !== null || change.newText !== null || change.diff !== null;
}

// Read the file-change list from a `{ files: [...] }` / `{ changes: [...] }`
// record (input or the structured result envelope).
function changeListOf(record: Record<string, unknown>): FileChange[] {
  const list = Array.isArray(record["changes"])
    ? record["changes"]
    : Array.isArray(record["files"])
      ? record["files"]
      : null;
  if (list === null) return [];
  return list
    .filter(isRecord)
    .map(normalizeChange)
    .filter((c): c is FileChange => c !== null);
}

// Extract the path from a `diff --git a/<path> b/<path>` header line.
function gitHeaderPath(line: string): string | null {
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  if (match === null) return null;
  // Prefer the b-side (destination) path; fall back to the a-side.
  return (match[2] ?? match[1] ?? "").trim() || null;
}

// Split a (possibly multi-file) unified diff into one FileChange per file, each
// carrying that file's diff segment. Codex buffers the fileChange/outputDelta
// stream into a single `output: "diff --git ..."` string on the result. A diff
// with no `diff --git` header is a single-file diff kept whole (path unknown).
function splitUnifiedDiff(output: string): FileChange[] {
  if (!output.includes("diff --git ")) {
    return [{ path: null, oldText: null, newText: null, diff: output }];
  }

  const lines = output.split("\n");
  const changes: FileChange[] = [];
  let path: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    changes.push({ path, oldText: null, newText: null, diff: buffer.join("\n") });
    buffer = [];
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      path = gitHeaderPath(line);
    }
    buffer.push(line);
  }
  flush();

  return changes;
}

// A unified-diff string carried on the result's `output` (or `diff`) field.
function resultUnifiedDiff(record: Record<string, unknown>): string | null {
  const output = readText(record, "output", "diff");
  return output !== null && output !== undefined && looksLikeUnifiedDiff(output) ? output : null;
}

// All file changes recoverable from the structured result: per-file
// `files`/`changes` entries plus any buffered unified-diff string on
// `output`/`diff` (Codex streams fileChange/outputDelta into one
// `{ files: [{path, op}], output: "diff --git ..." }` string).
function resultChanges(result: string | undefined): FileChange[] {
  const parsed = tryJson(result);
  if (parsed === undefined) return [];

  const listed = isRecord(parsed)
    ? changeListOf(parsed)
    : Array.isArray(parsed)
      ? parsed
          .filter(isRecord)
          .map(normalizeChange)
          .filter((c): c is FileChange => c !== null)
      : [];

  const unified = isRecord(parsed) ? resultUnifiedDiff(parsed) : null;
  const fromDiff = unified !== null ? splitUnifiedDiff(unified) : [];

  return [...listed, ...fromDiff];
}

// Fill in diff content on path/op-only input changes from the structured result,
// matched by path. Codex file-change completions persist `input.files` entries
// with only `{ path, op }` while the RESULT carries the buffered diff in
// `{ files, output }` — without this merge the diff would be lost.
function mergeResultDiff(inputChanges: FileChange[], result: string | undefined): FileChange[] {
  if (inputChanges.every(hasDiffContent)) return inputChanges;

  const fromResult = resultChanges(result).filter(hasDiffContent);
  if (fromResult.length === 0) return inputChanges;

  const byPath = new Map<string, FileChange>();
  for (const change of fromResult) {
    if (change.path !== null) byPath.set(change.path, change);
  }
  // A single result diff with no header path enriches a single path-only input.
  const pathlessDiff = fromResult.find((c) => c.path === null) ?? null;

  return inputChanges.map((change) => {
    if (hasDiffContent(change)) return change;
    const enriched =
      (change.path !== null ? byPath.get(change.path) : undefined) ??
      (inputChanges.length === 1 ? (pathlessDiff ?? undefined) : undefined);
    return enriched === undefined
      ? change
      : {
          path: change.path ?? enriched.path,
          oldText: enriched.oldText,
          newText: enriched.newText,
          diff: enriched.diff,
        };
  });
}

export function parseFileChanges(input: ToolInput, result: string | undefined): FileChange[] {
  const listed = changeListOf(input);
  if (listed.length > 0) return mergeResultDiff(listed, result);

  const single = normalizeChange(input);
  if (single !== null) return mergeResultDiff([single], result);

  // No file-change shape in the input at all: the result carries the changes
  // (per-file entries and/or a buffered unified-diff `output`).
  return resultChanges(result);
}

// ---------------------------------------------------------------------------
// Diff engine (trimmed port of tool-display/src/diff.ts)
// ---------------------------------------------------------------------------

// Inlined from `@aether/domain-types` — the Aether-only import is stripped.
export type DiffLine = {
  kind: "add" | "del" | "context";
  text: string;
  oldLine: number | null;
  newLine: number | null;
  noTrailingNewline?: boolean;
};

// `lines` is empty and `oversized` true when the input exceeded the LCS bound:
// the quadratic table is never allocated; only approximate +/− counts are
// reported.
export type DiffSummary = {
  added: number;
  removed: number;
  lines: DiffLine[];
  oversized: boolean;
};

// The per-side line cap on the LCS input. A quadratic DP table is only safe for
// modest edits; above this we refuse the line-level diff and summarize instead.
export const MAX_DIFF_INPUT_LINES = 2000;

function splitLines(code: string): string[] {
  if (code === "") return [];
  const lines = code.split("\n");
  // Drop the single trailing empty entry produced by a final newline.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// O(n+m) approximate +/− counts via multiset line differences — used only for
// oversized inputs where running the quadratic LCS is unsafe.
function approximateLineChanges(a: string[], b: string[]): { added: number; removed: number } {
  const counts = new Map<string, number>();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of b) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) counts.set(line, remaining - 1);
    else added++;
  }
  let removed = 0;
  for (const remaining of counts.values()) removed += remaining;
  return { added, removed };
}

// Longest-common-subsequence line diff. Bounded: for inputs above
// MAX_DIFF_INPUT_LINES on either side, returns an oversized summary WITHOUT
// ever allocating the O(n·m) table. All the non-null assertions below only
// discharge index-access widening — the LCS table is (n+1)×(m+1) and every
// access stays within i∈0..n / j∈0..m.
export function diffLines(oldCode: string, newCode: string): DiffSummary {
  const a = splitLines(oldCode);
  const b = splitLines(newCode);
  const n = a.length;
  const m = b.length;

  if (n > MAX_DIFF_INPUT_LINES || m > MAX_DIFF_INPUT_LINES) {
    const { added, removed } = approximateLineChanges(a, b);
    return { added, removed, lines: [], oversized: true };
  }

  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0),
  );
  for (let i = n - 1; i >= 0; i--) {
    const cur = lcs[i]!;
    const next = lcs[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      cur[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, cur[j + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ kind: "context", text: a[i]!, oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      lines.push({ kind: "del", text: a[i]!, oldLine: i + 1, newLine: null });
      removed++;
      i++;
    } else {
      lines.push({ kind: "add", text: b[j]!, oldLine: null, newLine: j + 1 });
      added++;
      j++;
    }
  }
  while (i < n) {
    lines.push({ kind: "del", text: a[i]!, oldLine: i + 1, newLine: null });
    removed++;
    i++;
  }
  while (j < m) {
    lines.push({ kind: "add", text: b[j]!, oldLine: null, newLine: j + 1 });
    added++;
    j++;
  }

  return { added, removed, lines, oversized: false };
}

// "@@ -oldStart[,oldCount] +newStart[,newCount] @@ ..." — the unified hunk
// header. A missing count is git's shorthand for 1.
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunkHeader(
  line: string,
): { oldStart: number; oldCount: number; newStart: number; newCount: number } | null {
  const match = HUNK_HEADER_RE.exec(line);
  if (match === null) return null;
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
}

type HunkLineClass =
  | { kind: "add" | "del" | "context"; text: string }
  | { kind: "no-newline-marker" }
  | { kind: "unclassifiable" };

function classifyHunkLine(raw: string): HunkLineClass {
  if (raw.startsWith("\\ ")) return { kind: "no-newline-marker" };
  if (raw.startsWith("+")) return { kind: "add", text: raw.slice(1) };
  if (raw.startsWith("-")) return { kind: "del", text: raw.slice(1) };
  if (raw.startsWith(" ")) return { kind: "context", text: raw.slice(1) };
  return { kind: "unclassifiable" };
}

// Build the numbered DiffLine for a classified content line, advancing the
// old/new cursors it consumes: an add consumes a new-side number, a del an
// old-side number, context one of each.
function numberedLine(
  cls: { kind: "add" | "del" | "context"; text: string },
  cursor: { oldLine: number; newLine: number },
): DiffLine {
  const { oldLine, newLine } = cursor;
  switch (cls.kind) {
    case "add":
      cursor.newLine = newLine + 1;
      return { kind: "add", text: cls.text, oldLine: null, newLine };
    case "del":
      cursor.oldLine = oldLine + 1;
      return { kind: "del", text: cls.text, oldLine, newLine: null };
    case "context":
      cursor.oldLine = oldLine + 1;
      cursor.newLine = newLine + 1;
      return { kind: "context", text: cls.text, oldLine, newLine };
  }
}

// Parse an already-unified diff string into typed lines (no algorithm needed —
// the +/-/space prefix is the classification). This is the LENIENT entry to
// the diff engine — the input is an untrusted tool payload, so an
// unclassifiable line renders VISIBLY as context instead of failing, and a
// hunk's declared counts are advisory.
export function parseUnifiedDiff(diff: string): DiffSummary {
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  // Line-number cursors. A hunk header re-anchors them to its declared starts;
  // input with no hunk header (a bare fragment) numbers from 1 as if the whole
  // fragment were one hunk.
  const cursor = { oldLine: 1, newLine: 1 };
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("@@")) {
      const header = parseHunkHeader(raw);
      if (header !== null) {
        cursor.oldLine = header.oldStart;
        cursor.newLine = header.newStart;
      }
      continue;
    }
    if (
      raw.startsWith("diff --git ") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ")
    ) {
      continue;
    }
    const cls = classifyHunkLine(raw);
    if (cls.kind === "no-newline-marker") {
      // A marker about the preceding line, not a content line. Folded onto
      // that line (dropped when nothing precedes).
      const last = lines.at(-1);
      if (last !== undefined) last.noTrailingNewline = true;
    } else if (cls.kind === "unclassifiable") {
      // Lenient policy: non-empty junk stays visible as context; empty lines
      // are structural, not content.
      if (raw.length > 0) lines.push(numberedLine({ kind: "context", text: raw }, cursor));
    } else {
      lines.push(numberedLine(cls, cursor));
      if (cls.kind === "add") added++;
      if (cls.kind === "del") removed++;
    }
  }
  return { added, removed, lines, oversized: false };
}

// Derive a renderable diff from a normalized FileChange, or null when it only
// carries a path (nothing to diff).
export function fileChangeDiff(change: FileChange): DiffSummary | null {
  if (change.oldText !== null && change.newText !== null) {
    return diffLines(change.oldText, change.newText);
  }
  if (change.diff !== null) {
    return parseUnifiedDiff(change.diff);
  }
  if (change.newText !== null) {
    // A pure creation: every line is an addition.
    return diffLines("", change.newText);
  }
  if (change.oldText !== null) {
    // A pure deletion: every line is a removal.
    return diffLines(change.oldText, "");
  }
  return null;
}
