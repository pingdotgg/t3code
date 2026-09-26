/**
 * Pure view-model for the Diff panel. Owns the read-side
 * model the view renders over the public `t3.vcs/diff` +
 * `t3.vcs/repository` contracts: patch → file rows, binary detection from
 * the delivered patch text, per-file hunk rows, gap expansion over
 * `getFileContents` payloads, and the capability gate.
 *
 * The parser is the vendored `@pierre/diffs` `parsePatchFiles` — the same
 * pure parser the native panel feeds (its React renderer cannot be
 * bundled: it imports react-dom, which the extension bundler rejects).
 * `hydratePartialDiff` is not a public subpath, so gap expansion is
 * re-derived here over the delivered full-file contents.
 *
 * Turn/checkpoint diffs ride the `t3.orchestration/*` contracts below;
 * diff-line comments (`t3.messages/enrichment`) live in diffComments.ts.
 */
import type { FileDiffMetadata } from "@pierre/diffs/types";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import type {
  AgentsEvent,
  OrchestrationCapabilities,
  OrchestrationCheckpoint,
  OrchestrationReceipt,
  OrchestrationSession,
  VcsCapabilitiesResult,
  VcsDiffFileContentsInput,
  VcsDiffFileContentsResult,
  VcsDiffFileContentsStreamEvent,
  VcsDiffPreviewInput,
  VcsDiffPreviewResult,
  VcsDiffPreviewSource,
  VcsDiffPreviewStreamEvent,
  VcsDiffStreamSource,
  VcsRefEntry,
  VcsStatusLocal,
  VcsStatusStreamEvent,
} from "@t3tools/extension-sdk/catalogue";

/* ---------------- paths ---------------- */

/** Strip the renderer prefix git applies (`a/` `b/`); mirrors native resolveFileDiffPath. */
export function resolveDiffPath(raw: string): string {
  if (raw.startsWith("a/") || raw.startsWith("b/")) return raw.slice(2);
  return raw;
}

/* ---------------- binary detection ---------------- */

const DIFF_GIT_BOUNDARY = /^diff --git /gm;
const BINARY_FILES_MARKER = /^Binary files .+ differ$/m;
const GIT_BINARY_MARKER = /^GIT binary patch$/m;
const BINARY_B_PATH = /^Binary files .+ and b\/(.+) differ$/m;
const HEADER_B_PATH_QUOTED = /^diff --git "a\/(?:.*)" "b\/(.*)"$/;
const HEADER_B_PATH = /^diff --git a\/.* b\/(.*)$/;

/**
 * Paths the delivered patch marks binary. Git emits either
 * `Binary files a/x and b/x differ` (the `b/` side names the file, even
 * for untracked `--no-index` entries where the a side is /dev/null) or a
 * `GIT binary patch` block (paths only on the `diff --git` header). A file
 * is named binary only when the literal marker exists for its path —
 * never inferred from missing hunks.
 */
export function binaryPathsFromPatch(diff: string): ReadonlySet<string> {
  const paths = new Set<string>();
  const boundaries = [...diff.matchAll(DIFF_GIT_BOUNDARY)].map((match) => match.index);
  for (let index = 0; index < boundaries.length; index += 1) {
    const start = boundaries[index];
    const end = index + 1 < boundaries.length ? boundaries[index + 1] : diff.length;
    const section = diff.slice(start, end);
    if (BINARY_FILES_MARKER.test(section)) {
      const path = BINARY_B_PATH.exec(section)?.[1];
      if (path !== undefined) paths.add(path);
    } else if (GIT_BINARY_MARKER.test(section)) {
      const header = section.split("\n", 1)[0] ?? "";
      const path =
        HEADER_B_PATH_QUOTED.exec(header)?.[1] ?? HEADER_B_PATH.exec(header)?.[1] ?? null;
      if (path !== null) paths.add(path);
    }
  }
  return paths;
}

/* ---------------- file rows ---------------- */

export type DiffChangeType = FileDiffMetadata["type"];

export interface DiffFileRow {
  /** Stable key for selection: prev + new path (renames differ on both). */
  readonly key: string;
  /** Workspace-relative new path (renderer prefix stripped). */
  readonly path: string;
  /** Workspace-relative old path for renames; null otherwise. */
  readonly prevPath: string | null;
  readonly changeType: DiffChangeType;
  readonly additions: number;
  readonly deletions: number;
  /** Literal binary marker in the patch — no fake text patch is rendered. */
  readonly binary: boolean;
  /** Parsed but carrying no text hunks (mode-only change, or a truncated tail). */
  readonly textless: boolean;
  readonly file: FileDiffMetadata;
}

function rowFromFile(file: FileDiffMetadata, binaryPaths: ReadonlySet<string>): DiffFileRow {
  const path = resolveDiffPath(file.name ?? file.prevName ?? "");
  const prevPath = file.prevName !== undefined ? resolveDiffPath(file.prevName) : null;
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  const binary = binaryPaths.has(path) || (prevPath !== null && binaryPaths.has(prevPath));
  return {
    key: `${prevPath ?? ""}\u0000${path}`,
    path,
    prevPath,
    changeType: file.type,
    additions,
    deletions,
    binary,
    textless: file.hunks.length === 0 && !binary,
    file,
  };
}

/* ---------------- patch → renderable ---------------- */

export type RenderableDiff =
  | { readonly kind: "files"; readonly files: readonly DiffFileRow[] }
  | { readonly kind: "raw"; readonly text: string; readonly reason: string };

/**
 * Mirrors native `getRenderablePatch` (diffRendering.ts): null on empty,
 * parsed file rows on success, and the honest `raw` fallback with a reason
 * when the delivered text is not a parseable patch.
 */
export function renderableFromPatch(diff: string | null | undefined): RenderableDiff | null {
  if (diff === null || diff === undefined) return null;
  const normalized = diff.trim();
  if (normalized.length === 0) return null;
  try {
    const files = parsePatchFiles(normalized, patchCacheKey(normalized)).flatMap(
      (patch) => patch.files,
    );
    if (files.length > 0) {
      const binaryPaths = binaryPathsFromPatch(normalized);
      return { kind: "files", files: files.map((file) => rowFromFile(file, binaryPaths)) };
    }
    return {
      kind: "raw",
      text: normalized,
      reason: "Unsupported diff format. Showing raw patch.",
    };
  } catch {
    return {
      kind: "raw",
      text: normalized,
      reason: "Failed to parse patch. Showing raw patch.",
    };
  }
}

/** Content-ish key so re-parses of identical payloads stay referentially cheap downstream. */
function patchCacheKey(patch: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < patch.length; index += 1) {
    hash ^= patch.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `t3.diff:${patch.length}:${hash.toString(36)}`;
}

/* ---------------- per-file display rows ---------------- */

export type DiffDisplayRow = {
  readonly ordinal: number;
  /**
   * True on the first row rendered for a hunk. Split pairing must not cross a
   * hunk boundary, and adjacent hunks (collapsedBefore 0) render with no
   * separator row between them — this flag is the only boundary signal.
   */
  readonly hunkStart?: boolean;
} & (
  | {
      readonly kind: "context";
      readonly text: string;
      readonly oldLine: number;
      readonly newLine: number;
    }
  | { readonly kind: "addition"; readonly text: string; readonly newLine: number }
  | { readonly kind: "deletion"; readonly text: string; readonly oldLine: number }
  /** Unmodified region: `collapsedBefore` lines, or the capped tail of an expanded gap. */
  | { readonly kind: "gap"; readonly count: number }
);

/** Upper bound on context rows an expanded gap paints before naming the remainder. */
export const MAX_EXPANDED_CONTEXT_LINES = 200;

export interface DiffFileContents {
  readonly oldContents: string;
  readonly newContents: string;
}

function splitLines(text: string): readonly string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Patch-parsed and contents-derived lines can carry a trailing newline (and
 * contents-derived CRLF lines a lone trailing `\r` after the split on `\n`);
 * display, quotes, and comparisons strip all of them so an unchanged CRLF
 * file compares equal and renders without the carriage returns.
 */
function lineText(lines: readonly string[], index: number): string {
  return (lines[index] ?? "").replace(/(\r\n|\r|\n)$/, "");
}

/**
 * Unified display rows for one file. Without `contents` the hunks render
 * exactly what the patch carries and every `collapsedBefore` region is a
 * named gap row ("N unmodified lines" — the native separator). With the
 * `getFileContents` payload the same math Pierre's hydrator performs
 * (gap = additionStart-1 - previous hunk end) splices the inter-hunk
 * context back in — bounded per gap so a huge file cannot flood the DOM.
 */
export function fileRows(
  row: DiffFileRow,
  contents?: DiffFileContents,
  maxExpandedContext = MAX_EXPANDED_CONTEXT_LINES,
): readonly DiffDisplayRow[] {
  const file = row.file;
  if (file.hunks.length === 0) return [];

  const expanded = contents !== undefined;
  const additionLines = expanded ? splitLines(contents.newContents) : file.additionLines;
  const deletionLines = expanded ? splitLines(contents.oldContents) : file.deletionLines;

  const rows: DiffDisplayRow[] = [];
  const pushGap = (oldStart: number, newStart: number, count: number) => {
    // Expanded gaps render real context up to the bound, then a named remainder.
    // Text is identical on both sides (unchanged region); old/new line numbers
    // diverge after additions/deletions, so each side keeps its own offset.
    const shown = Math.min(count, maxExpandedContext);
    for (let offset = 0; offset < shown; offset += 1) {
      rows.push({
        ordinal: rows.length,
        kind: "context",
        text: lineText(additionLines, newStart + offset),
        oldLine: oldStart + offset + 1,
        newLine: newStart + offset + 1,
      });
    }
    if (count > shown) rows.push({ ordinal: rows.length, kind: "gap", count: count - shown });
  };

  let lastAdditionEnd = 0;
  let lastDeletionEnd = 0;
  for (const hunk of file.hunks) {
    if (expanded) {
      const gap = Math.max(hunk.additionStart - 1 - lastAdditionEnd, 0);
      if (gap > 0) pushGap(lastDeletionEnd, lastAdditionEnd, gap);
    } else if (hunk.collapsedBefore > 0) {
      rows.push({ ordinal: rows.length, kind: "gap", count: hunk.collapsedBefore });
    }
    // Hunk content starts here — gap rows above belong to the skipped region,
    // and split pairing restarts at hunk content, not at the separator.
    const firstRowIndex = rows.length;

    // Text index into the line arrays (patch-scoped for partial diffs,
    // file-scoped once expanded) is tracked separately from the real
    // old/new file line numbers, which always come from the hunk header.
    let additionIndex = expanded ? Math.max(hunk.additionStart - 1, 0) : hunk.additionLineIndex;
    let deletionIndex = expanded ? Math.max(hunk.deletionStart - 1, 0) : hunk.deletionLineIndex;
    let newLine = hunk.additionStart;
    let oldLine = hunk.deletionStart;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          rows.push({
            ordinal: rows.length,
            kind: "context",
            text: lineText(additionLines, additionIndex + offset),
            oldLine: oldLine + offset,
            newLine: newLine + offset,
          });
        }
        additionIndex += content.lines;
        deletionIndex += content.lines;
        oldLine += content.lines;
        newLine += content.lines;
      } else {
        for (let offset = 0; offset < content.deletions; offset += 1) {
          rows.push({
            ordinal: rows.length,
            kind: "deletion",
            text: lineText(deletionLines, deletionIndex + offset),
            oldLine: oldLine + offset,
          });
        }
        deletionIndex += content.deletions;
        oldLine += content.deletions;
        for (let offset = 0; offset < content.additions; offset += 1) {
          rows.push({
            ordinal: rows.length,
            kind: "addition",
            text: lineText(additionLines, additionIndex + offset),
            newLine: newLine + offset,
          });
        }
        additionIndex += content.additions;
        newLine += content.additions;
      }
    }
    if (rows.length > firstRowIndex)
      rows[firstRowIndex] = { ...rows[firstRowIndex], hunkStart: true };
    lastAdditionEnd = hunk.additionStart + hunk.additionCount - 1;
    lastDeletionEnd = hunk.deletionStart + hunk.deletionCount - 1;
  }
  if (expanded) {
    const tail = Math.max(additionLines.length - lastAdditionEnd, 0);
    if (tail > 0) pushGap(lastDeletionEnd, lastAdditionEnd, tail);
  }
  return rows;
}

/* ---------------- split (side-by-side) rows ---------------- */

/**
 * One side of a paired split row. Context lines carry their own old/new line
 * number; `empty` pads the shorter side of a deletion/addition pair so both
 * panes stay aligned.
 */
export type SplitSide =
  | { readonly kind: "context"; readonly text: string; readonly line: number }
  | { readonly kind: "deletion"; readonly text: string; readonly line: number }
  | { readonly kind: "addition"; readonly text: string; readonly line: number }
  | { readonly kind: "empty" };

export type DiffSplitRow =
  | {
      readonly ordinal: number;
      readonly kind: "sides";
      readonly old: SplitSide;
      readonly new: SplitSide;
      /**
       * The unified row each side came from — the comment selection's index
       * space. Both are the same row for context; a paired row keeps its own
       * ordinal per side so a comment can target the addition or the deletion
       * it replaced; `undefined` pads the empty side of a pairing.
       */
      readonly oldOrdinal: number | undefined;
      readonly newOrdinal: number | undefined;
    }
  /** Full-width separator - the same gap row the unified layout renders. */
  | {
      readonly ordinal: number;
      readonly kind: "gap";
      readonly count: number;
      readonly unifiedOrdinal: number;
    };

/**
 * Unified display rows -> split (side-by-side) rows. Context appears on both
 * sides; within a hunk each run of deletions pairs line-by-line with the run
 * of additions that follows it, the shorter side padded with `empty` cells.
 * Gap rows and `hunkStart` boundaries flush the pairing, so a hunk's trailing
 * deletions never align with the next hunk's opening additions when adjacent
 * hunks render with no separator between them.
 */
export function splitRows(rows: readonly DiffDisplayRow[]): readonly DiffSplitRow[] {
  const out: DiffSplitRow[] = [];
  let oldRun: { readonly text: string; readonly line: number; readonly ordinal: number }[] = [];
  let newRun: { readonly text: string; readonly line: number; readonly ordinal: number }[] = [];
  const flush = () => {
    const height = Math.max(oldRun.length, newRun.length);
    for (let index = 0; index < height; index += 1) {
      const old = oldRun[index];
      const current = newRun[index];
      // height is the longer run, so every index hits at least one side.
      if (old === undefined && current === undefined) break;
      out.push({
        ordinal: out.length,
        kind: "sides",
        oldOrdinal: old?.ordinal,
        newOrdinal: current?.ordinal,
        old:
          old === undefined
            ? { kind: "empty" }
            : { kind: "deletion", text: old.text, line: old.line },
        new:
          current === undefined
            ? { kind: "empty" }
            : { kind: "addition", text: current.text, line: current.line },
      });
    }
    oldRun = [];
    newRun = [];
  };
  for (const row of rows) {
    // A hunk boundary ends any pending pairing - rows never pair across hunks.
    if (row.hunkStart === true && (oldRun.length > 0 || newRun.length > 0)) flush();
    if (row.kind === "gap") {
      flush();
      out.push({ ordinal: out.length, kind: "gap", count: row.count, unifiedOrdinal: row.ordinal });
    } else if (row.kind === "deletion") {
      // A deletion run starting after additions belongs to a new pairing -
      // back-to-back change blocks each keep their own runs.
      if (newRun.length > 0) flush();
      oldRun.push({ text: row.text, line: row.oldLine, ordinal: row.ordinal });
    } else if (row.kind === "addition") {
      newRun.push({ text: row.text, line: row.newLine, ordinal: row.ordinal });
    } else {
      flush();
      out.push({
        ordinal: out.length,
        kind: "sides",
        oldOrdinal: row.ordinal,
        newOrdinal: row.ordinal,
        old: { kind: "context", text: row.text, line: row.oldLine },
        new: { kind: "context", text: row.text, line: row.newLine },
      });
    }
  }
  flush();
  return out;
}

/** Only two-sided change files gain anything from the file-contents read. */
export function canExpandFile(row: DiffFileRow): boolean {
  return (
    !row.binary &&
    !row.textless &&
    (row.changeType === "change" || row.changeType === "rename-changed")
  );
}

/**
 * Whether delivered full-file contents agree with the patch snapshot on
 * every hunk line. Once loaded, the view renders hunk text from these
 * contents while comment quotes always come from the patch's own lines — a
 * file that changed between snapshot and fetch would make the two disagree
 * silently (displayed text ≠ quoted text, with no stale signal, since the
 * buffer pin only watches the contents themselves). Inconsistent contents
 * are refused: the view keeps patch-text rows and gap separators, so what
 * is shown and what is quoted stay on one snapshot. Gap-only differences
 * are fine — expanded gap lines display but never anchor or quote.
 */
export function expansionMatchesPatch(row: DiffFileRow, contents: DiffFileContents): boolean {
  const newLines = splitLines(contents.newContents);
  const oldLines = splitLines(contents.oldContents);
  for (const hunk of row.file.hunks) {
    let oldLineNumber = hunk.deletionStart;
    let newLineNumber = hunk.additionStart;
    let deletionLineIndex = hunk.deletionLineIndex;
    let additionLineIndex = hunk.additionLineIndex;
    for (const segment of hunk.hunkContent) {
      if (segment.type === "context") {
        for (let index = 0; index < segment.lines; index += 1) {
          // The same content source diffComments quotes from.
          const text = lineText(
            row.file.additionLines,
            additionLineIndex >= 0 ? additionLineIndex : deletionLineIndex,
          );
          if (
            lineText(newLines, newLineNumber - 1) !== text ||
            lineText(oldLines, oldLineNumber - 1) !== text
          ) {
            return false;
          }
          oldLineNumber += 1;
          newLineNumber += 1;
          deletionLineIndex += 1;
          additionLineIndex += 1;
        }
        continue;
      }
      for (let index = 0; index < segment.deletions; index += 1) {
        if (
          lineText(oldLines, oldLineNumber - 1) !==
          lineText(row.file.deletionLines, deletionLineIndex)
        ) {
          return false;
        }
        oldLineNumber += 1;
        deletionLineIndex += 1;
      }
      for (let index = 0; index < segment.additions; index += 1) {
        if (
          lineText(newLines, newLineNumber - 1) !==
          lineText(row.file.additionLines, additionLineIndex)
        ) {
          return false;
        }
        newLineNumber += 1;
        additionLineIndex += 1;
      }
    }
  }
  return true;
}

/** The `t3.vcs/diff` `getFileContents` input for one listed file. */
export function fileContentsInput(
  source: Pick<VcsDiffPreviewSource, "kind" | "baseRef" | "headRef">,
  row: DiffFileRow,
): VcsDiffFileContentsInput {
  return {
    sourceKind: source.kind,
    changeType: row.changeType,
    baseRef: source.baseRef,
    headRef: source.headRef,
    oldPath: row.prevPath ?? row.path,
    newPath: row.path,
  };
}

/* ---------------- labels ---------------- */

export function changeTypeLabel(changeType: DiffChangeType): string {
  switch (changeType) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
      return "renamed";
    case "rename-changed":
      return "renamed, modified";
    case "change":
      return "modified";
  }
}

/** Display path for a row: `old → new` for renames, `new` otherwise. */
export function displayPath(row: DiffFileRow): string {
  return row.prevPath !== null ? `${row.prevPath} → ${row.path}` : row.path;
}

/** Per-file stat text, e.g. "+12 −4"; binary and textless rows carry no counts. */
export function fileStatLabel(row: DiffFileRow): string {
  if (row.binary || row.textless) return "";
  return `+${row.additions} −${row.deletions}`;
}

/** Source switcher label: title + delivered hash prefix + truncation marker. */
export function describeSource(source: VcsDiffPreviewSource): string {
  const hash = source.diffHash.slice(0, 12);
  return `${source.title} · ${hash}${source.truncated ? " · truncated" : ""}`;
}

/* ---------------- comment section identity ---------------- */

/**
 * The section identity a diff comment carries. The native viewer filters
 * review comments by strict sectionId equality (AnnotatableCodeView), and
 * the native DiffPanel writes `turn:<turnId>` for checkpoint scopes,
 * `unstaged` for the working tree, `branch` for ref-range sources — any
 * other id reaches the composer draft but never renders inline. The
 * whole-thread diff has no native viewer section; its comments ride into
 * the composer draft under `thread`.
 */
export function commentSectionFor(
  mode: DiffMode,
  turnSelection: TurnSelection | null,
  source: Pick<VcsDiffPreviewSource, "kind"> | null,
): { readonly id: string; readonly title: string } {
  if (mode === "turns") {
    if (turnSelection?.kind === "turn") {
      return { id: `turn:${turnSelection.turnId}`, title: `Turn ${turnSelection.turnCount}` };
    }
    return { id: "thread", title: "All turns" };
  }
  return source !== null && source.kind === "working-tree"
    ? { id: "unstaged", title: "Working tree" }
    : { id: "branch", title: "Branch changes" };
}

/* ---------------- source + selection state ---------------- */

export const WORKING_TREE_KIND = "working-tree" as const;

/**
 * Pick the displayed source: the persisted choice when it still exists,
 * the dirty-worktree source by default (the native default scope), else
 * the first source the host delivered.
 */
export function selectSource(
  result: VcsDiffPreviewResult | null | undefined,
  wantedId: string | null | undefined,
): VcsDiffPreviewSource | null {
  const sources = result?.sources ?? [];
  if (sources.length === 0) return null;
  const wanted = wantedId !== null && wantedId !== undefined ? wantedId : WORKING_TREE_KIND;
  return sources.find((source) => source.id === wanted) ?? sources[0] ?? null;
}

/** Keep a selected file across refreshes; drops once the path leaves the list. */
export function retainFileSelection(
  files: readonly DiffFileRow[],
  selectedKey: string | null,
): DiffFileRow | null {
  if (selectedKey === null) return null;
  return files.find((row) => row.key === selectedKey) ?? null;
}

/* ---------------- preview + capability states ---------------- */

export type PreviewState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly detail: string }
  | { readonly kind: "empty" }
  | { readonly kind: "ready"; readonly result: VcsDiffPreviewResult };

/**
 * `null` result with no error means the invoke has not resolved yet —
 * loading. An empty `sources` array is the host's real answer for a
 * non-repo or a preview with nothing to report — the honest empty state.
 */
export function previewState(
  result: VcsDiffPreviewResult | null,
  error: string | null,
): PreviewState {
  if (error !== null) return { kind: "error", detail: error };
  if (result === null) return { kind: "loading" };
  if (result.sources.length === 0) return { kind: "empty" };
  return { kind: "ready", result };
}

export type DiffCapabilityState =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly detail: string }
  | { readonly kind: "no-repository"; readonly detail: string | null }
  | { readonly kind: "unsupported"; readonly driverKind: string; readonly detail: string }
  | { readonly kind: "ready" };

/**
 * The honesty gate: capabilities decide whether the panel renders
 * real state, a real no-repo state, or a named unsupported driver — never
 * a fabricated empty diff.
 */
export function diffCapabilityState(
  capabilities: VcsCapabilitiesResult | null,
  error: string | null,
): DiffCapabilityState {
  if (error !== null) return { kind: "unavailable", detail: error };
  if (capabilities === null) return { kind: "loading" };
  if (!capabilities.detected) {
    return { kind: "no-repository", detail: capabilities.detail };
  }
  if (!capabilities.operations["diff.getPreview"]) {
    const kind = capabilities.kind ?? "unknown";
    return {
      kind: "unsupported",
      driverKind: kind,
      detail: `The detected ${kind} driver does not serve diff previews.`,
    };
  }
  return { kind: "ready" };
}

/* ---------------- stream-vs-unary delivery policy ---------------- */

/**
 * The broker wraps every invoke result in a 64 KiB envelope; its named
 * rejection is the only authoritative "too big" signal — no contract
 * exposes diff byte size beforehand, and status line counts do not
 * measure it (context lines, headers, untracked bodies, renames, and
 * binary markers all decouple the two). Unary stays the cheap common
 * path; this predicate is the control signal for the stream fallback.
 */
export function isEnvelopeRejection(error: unknown): boolean {
  return error instanceof Error && /byte limit/i.test(error.message);
}

/** Sticky stream verdicts are keyed per preview input. */
export function previewDeliveryKey(input: VcsDiffPreviewInput): string {
  return `${input.baseRef ?? ""}|${input.ignoreWhitespace === true ? "w" : ""}`;
}

/** …and per expanded file within one delivered source. */
export function contentsDeliveryKey(
  source: Pick<VcsDiffPreviewSource, "id" | "diffHash">,
  row: Pick<DiffFileRow, "key">,
): string {
  return `${source.id}:${source.diffHash}:${row.key}`;
}

export type FetchOutcome<T> =
  | { readonly kind: "ready"; readonly result: T; readonly via: "unary" | "stream" }
  | { readonly kind: "error"; readonly detail: string }
  | { readonly kind: "cancelled" };

/** Upper bound on remembered stream verdicts; clears wholesale when hit. */
export const MAX_STREAM_KEYS = 64;

/**
 * Unary-first preview fetch with the named-envelope fallback: a
 * `byte limit` rejection records the input's key in `streamKeys` (the
 * sticky verdict — a diff large once is usually large across refreshes)
 * and retries over `streamPreview`, whose reassembly must verify before
 * anything is returned. Cancellation is silent at every stage.
 */
export async function fetchDiffPreview(options: {
  readonly input: VcsDiffPreviewInput;
  readonly invoke: (input: VcsDiffPreviewInput) => Promise<VcsDiffPreviewResult>;
  readonly stream: (
    input: VcsDiffPreviewInput,
  ) => AsyncIterable<StreamFrameLike<VcsDiffPreviewStreamEvent>>;
  readonly streamKeys: Set<string>;
  readonly signal: AbortSignal;
}): Promise<FetchOutcome<VcsDiffPreviewResult>> {
  const { input, invoke, stream, streamKeys, signal } = options;
  const key = previewDeliveryKey(input);
  if (!streamKeys.has(key)) {
    try {
      const result = await invoke(input);
      return signal.aborted ? { kind: "cancelled" } : { kind: "ready", result, via: "unary" };
    } catch (error) {
      if (signal.aborted) return { kind: "cancelled" };
      if (!isEnvelopeRejection(error)) {
        return {
          kind: "error",
          detail: error instanceof Error ? error.message : "Diff preview unavailable",
        };
      }
      if (streamKeys.size >= MAX_STREAM_KEYS) streamKeys.clear();
      streamKeys.add(key);
    }
  }
  return fetchStreamedPreview(stream(input), signal);
}

async function fetchStreamedPreview(
  stream: AsyncIterable<StreamFrameLike<VcsDiffPreviewStreamEvent>>,
  signal: AbortSignal,
): Promise<FetchOutcome<VcsDiffPreviewResult>> {
  let collected: Awaited<ReturnType<typeof collectPreviewStream>>;
  try {
    collected = await collectPreviewStream(stream, signal);
  } catch (error) {
    if (signal.aborted) return { kind: "cancelled" };
    return {
      kind: "error",
      detail: error instanceof Error ? error.message : "Diff stream unavailable",
    };
  }
  return streamOutcome(collected, signal);
}

function streamOutcome<T>(
  collected:
    | { readonly kind: "verified"; readonly result: T }
    | { readonly kind: "protocol" | "incomplete" | "mismatch"; readonly detail: string }
    | { readonly kind: "cancelled" },
  signal: AbortSignal,
): FetchOutcome<T> {
  switch (collected.kind) {
    case "verified":
      return signal.aborted
        ? { kind: "cancelled" }
        : { kind: "ready", result: collected.result, via: "stream" };
    case "cancelled":
      return { kind: "cancelled" };
    case "protocol":
      return { kind: "error", detail: `Diff stream protocol error: ${collected.detail}` };
    case "incomplete":
      return {
        kind: "error",
        detail: `Diff stream ended before completing — ${collected.detail}. Refresh to retry.`,
      };
    case "mismatch":
      return {
        kind: "error",
        detail: `Diff verification failed: ${collected.detail}. Nothing is shown.`,
      };
  }
}

/**
 * Same unary-first/stream-fallback policy for `getFileContents` — its
 * 1 MB/side contract bound sits far above the invoke envelope, so large
 * files hit the identical cliff.
 */
export async function fetchFileContents(options: {
  readonly input: VcsDiffFileContentsInput;
  readonly deliveryKey: string;
  readonly invoke: (input: VcsDiffFileContentsInput) => Promise<VcsDiffFileContentsResult>;
  readonly stream: (
    input: VcsDiffFileContentsInput,
  ) => AsyncIterable<StreamFrameLike<VcsDiffFileContentsStreamEvent>>;
  readonly streamKeys: Set<string>;
  readonly signal: AbortSignal;
}): Promise<FetchOutcome<VcsDiffFileContentsResult>> {
  const { input, deliveryKey, invoke, stream, streamKeys, signal } = options;
  if (!streamKeys.has(deliveryKey)) {
    try {
      const result = await invoke(input);
      return signal.aborted ? { kind: "cancelled" } : { kind: "ready", result, via: "unary" };
    } catch (error) {
      if (signal.aborted) return { kind: "cancelled" };
      if (!isEnvelopeRejection(error)) {
        return {
          kind: "error",
          detail: error instanceof Error ? error.message : "File contents unavailable",
        };
      }
      if (streamKeys.size >= MAX_STREAM_KEYS) streamKeys.clear();
      streamKeys.add(deliveryKey);
    }
  }
  let collected: Awaited<ReturnType<typeof collectFileContentsStream>>;
  try {
    collected = await collectFileContentsStream(stream(input), signal);
  } catch (error) {
    if (signal.aborted) return { kind: "cancelled" };
    return {
      kind: "error",
      detail: error instanceof Error ? error.message : "File contents stream unavailable",
    };
  }
  return streamOutcome(collected, signal);
}

/* ---------------- stream reassembly + verification ---------------- */

export interface StreamFrameLike<T> {
  readonly value: T;
}

/** Terminal failure kinds a stream delivery can end in. */
export type StreamFailure =
  | { readonly kind: "protocol"; readonly detail: string }
  | { readonly kind: "incomplete"; readonly detail: string }
  | { readonly kind: "mismatch"; readonly detail: string }
  | { readonly kind: "cancelled" };

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

export interface PreviewAssembly {
  readonly manifest: {
    readonly generatedAt: string;
    readonly sources: readonly VcsDiffStreamSource[];
  } | null;
  /** Per-source chunks in arrival order; strict `chunkIndex` sequence. */
  readonly chunks: readonly (readonly string[])[];
  readonly complete: string | null;
}

export function createPreviewAssembly(): PreviewAssembly {
  return { manifest: null, chunks: [], complete: null };
}

type FoldResult<T> =
  | { readonly ok: true; readonly assembly: T }
  | { readonly ok: false; readonly detail: string };

/**
 * Fold one `streamPreview` event. Frames must arrive manifest → ordered
 * chunks → complete; out-of-order, duplicated, or undeclared chunks are
 * protocol failures — accepting them would hide transport breakage.
 */
export function applyPreviewStreamEvent(
  assembly: PreviewAssembly,
  event: VcsDiffPreviewStreamEvent,
): FoldResult<PreviewAssembly> {
  if (assembly.complete !== null) {
    return { ok: false, detail: "stream continued after the complete frame" };
  }
  if (event.kind === "manifest") {
    if (assembly.manifest !== null) return { ok: false, detail: "duplicate manifest frame" };
    return {
      ok: true,
      assembly: {
        manifest: { generatedAt: event.generatedAt, sources: event.sources },
        chunks: event.sources.map(() => []),
        complete: null,
      },
    };
  }
  if (assembly.manifest === null) {
    return { ok: false, detail: `${event.kind} frame arrived before the manifest` };
  }
  if (event.kind === "chunk") {
    const source = assembly.manifest.sources[event.sourceIndex];
    if (source === undefined) {
      return { ok: false, detail: `chunk for unknown sourceIndex ${event.sourceIndex}` };
    }
    if (event.chunkIndex >= source.chunkCount) {
      return {
        ok: false,
        detail: `chunkIndex ${event.chunkIndex} exceeds declared chunkCount ${source.chunkCount} for source ${source.id}`,
      };
    }
    const received = assembly.chunks[event.sourceIndex] ?? [];
    if (event.chunkIndex !== received.length) {
      return {
        ok: false,
        detail: `out-of-order chunk ${event.chunkIndex} for source ${source.id} (expected ${received.length})`,
      };
    }
    const chunks = assembly.chunks.slice();
    chunks[event.sourceIndex] = [...received, event.data];
    return { ok: true, assembly: { ...assembly, chunks } };
  }
  return { ok: true, assembly: { ...assembly, complete: event.payloadSha256 } };
}

export type PreviewVerification =
  | { readonly kind: "verified"; readonly result: VcsDiffPreviewResult }
  | StreamFailure;

/**
 * Terminal verification: declared chunk counts, reassembled UTF-8 byte
 * lengths, per-source sha256, then the whole-payload sha256 — in that
 * order, before a single byte reaches the render path.
 */
export async function verifyPreviewAssembly(
  assembly: PreviewAssembly,
): Promise<PreviewVerification> {
  if (assembly.manifest === null) {
    return { kind: "incomplete", detail: "stream ended before the manifest" };
  }
  if (assembly.complete === null) {
    return { kind: "incomplete", detail: "stream ended before the complete frame" };
  }
  const bodies: string[] = [];
  for (const [index, source] of assembly.manifest.sources.entries()) {
    const chunks = assembly.chunks[index] ?? [];
    if (chunks.length !== source.chunkCount) {
      return {
        kind: "incomplete",
        detail: `source ${source.id}: received ${chunks.length} of ${source.chunkCount} declared chunks`,
      };
    }
    const body = chunks.join("");
    if (utf8Length(body) !== source.diffByteLength) {
      return {
        kind: "mismatch",
        detail: `source ${source.id}: reassembled byte length does not match the manifest`,
      };
    }
    if ((await sha256Hex(body)) !== source.diffHash) {
      return {
        kind: "mismatch",
        detail: `source ${source.id}: reassembled bytes do not match the manifest hash`,
      };
    }
    bodies.push(body);
  }
  if ((await sha256Hex(bodies.join(""))) !== assembly.complete) {
    return { kind: "mismatch", detail: "reassembled payload does not match the terminal checksum" };
  }
  const manifest = assembly.manifest;
  return {
    kind: "verified",
    result: {
      generatedAt: manifest.generatedAt,
      sources: manifest.sources.map((source, index) => ({
        id: source.id,
        kind: source.kind,
        title: source.title,
        baseRef: source.baseRef,
        headRef: source.headRef,
        diff: bodies[index] ?? "",
        diffHash: source.diffHash,
        truncated: source.truncated,
      })),
    },
  };
}

/**
 * Consume a `streamPreview` iterable into a verified preview. The abort
 * signal is checked before every frame and leaving the loop abandons the
 * iterator — the contract's cancellation mechanism. Nothing is produced
 * before the terminal checksum verifies, so unverified bytes can never
 * reach the caller.
 */
export async function collectPreviewStream(
  stream: AsyncIterable<StreamFrameLike<VcsDiffPreviewStreamEvent>>,
  signal: AbortSignal,
): Promise<PreviewVerification> {
  let assembly = createPreviewAssembly();
  for await (const frame of stream) {
    if (signal.aborted) return { kind: "cancelled" };
    const next = applyPreviewStreamEvent(assembly, frame.value);
    if (!next.ok) return { kind: "protocol", detail: next.detail };
    assembly = next.assembly;
  }
  if (signal.aborted) return { kind: "cancelled" };
  return verifyPreviewAssembly(assembly);
}

export interface FileContentsAssembly {
  readonly manifest: {
    readonly oldByteLength: number;
    readonly oldChunkCount: number;
    readonly newByteLength: number;
    readonly newChunkCount: number;
  } | null;
  readonly sides: {
    readonly old: readonly string[];
    readonly new: readonly string[];
  };
  readonly complete: { readonly oldSha256: string; readonly newSha256: string } | null;
}

export function createFileContentsAssembly(): FileContentsAssembly {
  return { manifest: null, sides: { old: [], new: [] }, complete: null };
}

/** `streamFileContents` fold — identical ordering rules, per side. */
export function applyFileContentsStreamEvent(
  assembly: FileContentsAssembly,
  event: VcsDiffFileContentsStreamEvent,
): FoldResult<FileContentsAssembly> {
  if (assembly.complete !== null) {
    return { ok: false, detail: "stream continued after the complete frame" };
  }
  if (event.kind === "manifest") {
    if (assembly.manifest !== null) return { ok: false, detail: "duplicate manifest frame" };
    return {
      ok: true,
      assembly: {
        manifest: {
          oldByteLength: event.oldByteLength,
          oldChunkCount: event.oldChunkCount,
          newByteLength: event.newByteLength,
          newChunkCount: event.newChunkCount,
        },
        sides: { old: [], new: [] },
        complete: null,
      },
    };
  }
  if (assembly.manifest === null) {
    return { ok: false, detail: `${event.kind} frame arrived before the manifest` };
  }
  if (event.kind === "chunk") {
    const declared =
      event.side === "old" ? assembly.manifest.oldChunkCount : assembly.manifest.newChunkCount;
    if (event.chunkIndex >= declared) {
      return {
        ok: false,
        detail: `chunkIndex ${event.chunkIndex} exceeds declared ${event.side} chunkCount ${declared}`,
      };
    }
    const received = assembly.sides[event.side];
    if (event.chunkIndex !== received.length) {
      return {
        ok: false,
        detail: `out-of-order ${event.side} chunk ${event.chunkIndex} (expected ${received.length})`,
      };
    }
    return {
      ok: true,
      assembly: {
        ...assembly,
        sides: { ...assembly.sides, [event.side]: [...received, event.data] },
      },
    };
  }
  return {
    ok: true,
    assembly: {
      ...assembly,
      complete: { oldSha256: event.oldSha256, newSha256: event.newSha256 },
    },
  };
}

export type FileContentsVerification =
  | { readonly kind: "verified"; readonly result: VcsDiffFileContentsResult }
  | StreamFailure;

/** Per-side verification of a reassembled `streamFileContents` delivery. */
export async function verifyFileContentsAssembly(
  assembly: FileContentsAssembly,
): Promise<FileContentsVerification> {
  if (assembly.manifest === null) {
    return { kind: "incomplete", detail: "stream ended before the manifest" };
  }
  if (assembly.complete === null) {
    return { kind: "incomplete", detail: "stream ended before the complete frame" };
  }
  const manifest = assembly.manifest;
  const complete = assembly.complete;
  const sides = [
    {
      name: "old" as const,
      chunks: assembly.sides.old,
      chunkCount: manifest.oldChunkCount,
      byteLength: manifest.oldByteLength,
      sha256: complete.oldSha256,
    },
    {
      name: "new" as const,
      chunks: assembly.sides.new,
      chunkCount: manifest.newChunkCount,
      byteLength: manifest.newByteLength,
      sha256: complete.newSha256,
    },
  ];
  const bodies: { old?: string; new?: string } = {};
  for (const side of sides) {
    if (side.chunks.length !== side.chunkCount) {
      return {
        kind: "incomplete",
        detail: `${side.name} side: received ${side.chunks.length} of ${side.chunkCount} declared chunks`,
      };
    }
    const body = side.chunks.join("");
    if (utf8Length(body) !== side.byteLength) {
      return {
        kind: "mismatch",
        detail: `${side.name} side: reassembled byte length does not match the manifest`,
      };
    }
    if ((await sha256Hex(body)) !== side.sha256) {
      return {
        kind: "mismatch",
        detail: `${side.name} side: reassembled bytes do not match the complete-frame hash`,
      };
    }
    bodies[side.name] = body;
  }
  return {
    kind: "verified",
    result: { oldContents: bodies.old ?? "", newContents: bodies.new ?? "" },
  };
}

/** `streamFileContents` consumer — the same abandon-and-verify discipline. */
export async function collectFileContentsStream(
  stream: AsyncIterable<StreamFrameLike<VcsDiffFileContentsStreamEvent>>,
  signal: AbortSignal,
): Promise<FileContentsVerification> {
  let assembly = createFileContentsAssembly();
  for await (const frame of stream) {
    if (signal.aborted) return { kind: "cancelled" };
    const next = applyFileContentsStreamEvent(assembly, frame.value);
    if (!next.ok) return { kind: "protocol", detail: next.detail };
    assembly = next.assembly;
  }
  if (signal.aborted) return { kind: "cancelled" };
  return verifyFileContentsAssembly(assembly);
}

/* ---------------- status-stream refresh ---------------- */

export interface DiffStatusRefresh {
  /**
   * Fingerprint of the last local status the stream delivered. The
   * preview refreshes once per *distinct* fingerprint — the native
   * discipline of one refresh per mutation event, never per frame.
   */
  readonly fingerprint: string | null;
  readonly revision: number;
  readonly stream: "connecting" | "live" | "ended";
  readonly detail: string | null;
}

export const CONNECTING_DIFF_STATUS: DiffStatusRefresh = {
  fingerprint: null,
  revision: 0,
  stream: "connecting",
  detail: null,
};

/** The local-status fields a diff actually reads. */
export function localStatusFingerprint(local: VcsStatusLocal): string {
  return [
    local.refName ?? "",
    local.hasWorkingTreeChanges ? "1" : "0",
    local.workingTree.files.length,
    local.workingTree.insertions,
    local.workingTree.deletions,
    local.workingTree.truncated ? "1" : "0",
  ].join("|");
}

/**
 * Fold a `t3.vcs/status` frame into the refresh model. The first
 * snapshot sets the baseline without bumping the revision — the preview
 * already loads on mount — while a reconnect snapshot whose fingerprint
 * moved refreshes exactly once. `remoteUpdated` never refreshes: the
 * diff reads local refs and the working tree, not remote bookkeeping.
 */
export function foldDiffStatusEvent(
  model: DiffStatusRefresh,
  event: VcsStatusStreamEvent,
): DiffStatusRefresh {
  switch (event.kind) {
    case "snapshot": {
      const fingerprint = localStatusFingerprint(event.local);
      const changed = model.fingerprint !== null && model.fingerprint !== fingerprint;
      return {
        fingerprint,
        revision: model.revision + (changed ? 1 : 0),
        stream: "live",
        detail: null,
      };
    }
    case "localUpdated": {
      const fingerprint = localStatusFingerprint(event.local);
      return {
        ...model,
        fingerprint,
        revision: model.revision + (model.fingerprint !== fingerprint ? 1 : 0),
        stream: "live",
      };
    }
    case "remoteUpdated":
      return model;
    case "closed":
      return {
        ...model,
        stream: "ended",
        detail:
          event.reason === "overflow"
            ? "The status stream overflowed its event queue."
            : "The status stream reported a status error.",
      };
  }
}

/* ---------------- base-ref choices ---------------- */

export interface BaseRefChoice {
  readonly id: string;
  readonly label: string;
  /** The value sent as `baseRef` — local name, or remote name for remote-only refs. */
  readonly refName: string;
  readonly remote: boolean;
}

function remoteBranchName(ref: VcsRefEntry): string {
  if (ref.remoteName !== undefined && ref.name.startsWith(`${ref.remoteName}/`)) {
    return ref.name.slice(ref.remoteName.length + 1);
  }
  return ref.name;
}

/**
 * Pairs each local ref with its same-named remote (preferring `origin`),
 * then appends the unpaired remote refs — the native
 * `buildBaseRefChoices` shape over the public `VcsRefEntry` list.
 */
export function buildBaseRefChoices(refs: readonly VcsRefEntry[]): readonly BaseRefChoice[] {
  const localRefs = refs.filter((ref) => ref.isRemote !== true);
  const remoteRefs = refs.filter((ref) => ref.isRemote === true);
  const unusedRemotes = new Set(remoteRefs);
  const paired = localRefs.map((local) => {
    const matches = remoteRefs.filter(
      (remote) => unusedRemotes.has(remote) && remoteBranchName(remote) === local.name,
    );
    const remote =
      matches.find((candidate) => candidate.remoteName === "origin") ?? matches[0] ?? null;
    if (remote !== null) unusedRemotes.delete(remote);
    return {
      id: `local:${local.name}`,
      label: local.name,
      refName: local.name,
      remote: remote !== null,
    };
  });
  const remoteOnly = remoteRefs
    .filter((remote) => unusedRemotes.has(remote))
    .map((remote) => ({
      id: `remote:${remote.name}`,
      label: remote.name,
      refName: remote.name,
      remote: true,
    }));
  return [...paired, ...remoteOnly];
}

/** Substring filter over the label and the sent ref name. */
export function filterBaseRefChoices(
  choices: readonly BaseRefChoice[],
  query: string,
): readonly BaseRefChoice[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return choices;
  return choices.filter(
    (choice) =>
      choice.label.toLocaleLowerCase().includes(normalized) ||
      choice.refName.toLocaleLowerCase().includes(normalized),
  );
}

/* ---------------- file tree ---------------- */

export type DiffTreeRow =
  | {
      readonly kind: "dir";
      /** Trailing-slash directory path — the collapse-state key, as native uses. */
      readonly path: string;
      readonly name: string;
      readonly depth: number;
      readonly collapsed: boolean;
      readonly fileCount: number;
    }
  | {
      readonly kind: "file";
      readonly row: DiffFileRow;
      readonly name: string;
      readonly depth: number;
    };

interface DirNode {
  readonly dirs: Map<string, DirNode>;
  readonly files: DiffFileRow[];
}

function countTreeFiles(node: DirNode): number {
  let count = node.files.length;
  for (const child of node.dirs.values()) count += countTreeFiles(child);
  return count;
}

/**
 * Flat indented tree rows for the file pane — the native diffFileTree
 * semantics (every directory on the way to a file, parents before
 * children) as a package-owned row list: directories first, then files,
 * each alphabetically sorted; collapsed directories hide descendants.
 */
export function diffTreeRows(
  files: readonly DiffFileRow[],
  collapsedDirs: ReadonlySet<string>,
): readonly DiffTreeRow[] {
  const root: DirNode = { dirs: new Map(), files: [] };
  for (const row of files) {
    const segments = row.path.split("/");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let child = node.dirs.get(segment);
      if (child === undefined) {
        child = { dirs: new Map(), files: [] };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.push(row);
  }
  const rows: DiffTreeRow[] = [];
  const walk = (node: DirNode, path: string, depth: number) => {
    for (const [name, child] of [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const dirPath = `${path}${name}/`;
      rows.push({
        kind: "dir",
        path: dirPath,
        name,
        depth,
        collapsed: collapsedDirs.has(dirPath),
        fileCount: countTreeFiles(child),
      });
      if (!collapsedDirs.has(dirPath)) walk(child, dirPath, depth + 1);
    }
    for (const file of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({
        kind: "file",
        row: file,
        name: file.path.split("/").pop() ?? file.path,
        depth,
      });
    }
  };
  walk(root, "", 0);
  return rows;
}

/* ---------------- collapse-all ---------------- */

/** Ported verbatim from the native diffCollapse semantics. */
export function areAllDiffFilesCollapsed(
  fileKeys: readonly string[],
  collapsedFileKeys: ReadonlySet<string>,
): boolean {
  return fileKeys.length > 0 && fileKeys.every((key) => collapsedFileKeys.has(key));
}

export function toggleAllDiffFiles(
  fileKeys: readonly string[],
  collapsedFileKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  return areAllDiffFilesCollapsed(fileKeys, collapsedFileKeys) ? new Set() : new Set(fileKeys);
}

export function toggleCollapsedKey(
  collapsedKeys: ReadonlySet<string>,
  key: string,
): ReadonlySet<string> {
  const next = new Set(collapsedKeys);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

/* ---------------- file presentation (open-in-editor) ---------------- */

/**
 * Safety check before `t3.file/presentation.open`: the path must be
 * workspace-relative — the safety half of the native
 * `resolveDiffPathForWorkspace` (reject absolute, empty, and `..`
 * segments). No repo-root remap exists on the public surface, so paths
 * are passed through as delivered.
 */
export function presentationPath(path: string): string | null {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "..")
  ) {
    return null;
  }
  return path;
}

/** Honest report of a resolved `t3.file/presentation.open` descriptor. */
export function describePresentation(result: {
  readonly surfaceId: string;
  readonly placement: string;
}): string {
  return `opens in ${result.surfaceId} · ${result.placement}`;
}

/* ---------------- turn/checkpoint mode (t3.orchestration) ---------------- */

/** The panel's two data paths: repository sources vs turn-scoped checkpoint diffs. */
export type DiffMode = "workspace" | "turns";

/** Row layout: one unified pane, or split old/new panes (native `diffLayout`). */
export type DiffLayout = "unified" | "split";

/**
 * The persisted selection record (`session.save`). Fields stay sparse -
 * defaults are omitted so older records restore unchanged. `layout` is
 * per-view: the plugin cannot read or write the host's client settings, so
 * the global native `diffLayout` preference and this record are separate.
 * `wrap` is deliberately absent - the native wrap toggle is session-local.
 */
export interface RestoredState {
  readonly mode?: string;
  readonly sourceId?: string;
  readonly fileKey?: string;
  readonly baseRef?: string;
  readonly ignoreWhitespace?: boolean;
  /** Persisted turn selection - `turnId` for a turn pick, absent + mode "turns" for the whole thread. */
  readonly turnId?: string;
  /** Row layout; records saved before split shipped restore as unified. */
  readonly layout?: DiffLayout;
}

/** `validateRestore` for the diff surface: null, or a sparse selection record with known keys. */
export function restoreDiffState(value: unknown): value is RestoredState | null {
  if (value === null) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every(
      (key) =>
        key === "mode" ||
        key === "sourceId" ||
        key === "fileKey" ||
        key === "baseRef" ||
        key === "ignoreWhitespace" ||
        key === "turnId" ||
        key === "layout",
    ) &&
    (record.mode === undefined || record.mode === "workspace" || record.mode === "turns") &&
    (record.sourceId === undefined || typeof record.sourceId === "string") &&
    (record.fileKey === undefined || typeof record.fileKey === "string") &&
    (record.baseRef === undefined || typeof record.baseRef === "string") &&
    (record.ignoreWhitespace === undefined || typeof record.ignoreWhitespace === "boolean") &&
    (record.turnId === undefined || typeof record.turnId === "string") &&
    (record.layout === undefined || record.layout === "unified" || record.layout === "split")
  );
}

/**
 * The agents-stream fold the panel needs: the checkpoint list drives the
 * turn picker, the session row labels it, and `revision`/`streamEpoch`
 * mirror the projection so a revert receipt can be reconciled against the
 * state it was issued on. Agents/approvals never reach the diff view.
 */
export interface AgentsModel {
  readonly revision: number;
  readonly streamEpoch: string | null;
  readonly stream: "connecting" | "live" | "ended";
  readonly detail: string | null;
  readonly checkpoints: readonly OrchestrationCheckpoint[];
  readonly session: OrchestrationSession | null;
}

export const CONNECTING_AGENTS: AgentsModel = {
  revision: 0,
  streamEpoch: null,
  stream: "connecting",
  detail: null,
  checkpoints: [],
  session: null,
};

/**
 * Fold one `subscribeAgents` frame. `closed` names the overflow reason —
 * the only close the contract emits — and leaves the last checkpoints
 * visible while the view resubscribes.
 */
export function foldAgentsEvent(model: AgentsModel, event: AgentsEvent): AgentsModel {
  switch (event.kind) {
    case "snapshot":
    case "updated":
      return {
        revision: event.revision,
        streamEpoch: event.streamEpoch,
        stream: "live",
        detail: null,
        checkpoints: event.checkpoints,
        session: event.session,
      };
    case "receipt":
      // Control invokes return their receipts directly; the stream copy is
      // for other clients and carries nothing the diff panel renders.
      return { ...model, revision: event.revision, streamEpoch: event.streamEpoch };
    case "closed":
      return {
        ...model,
        stream: "ended",
        detail: "The orchestration stream overflowed its event queue.",
      };
  }
}

/** One pickable checkpoint, newest-first. */
export interface TurnChoice {
  readonly turnId: string;
  readonly turnCount: number;
  /** `Turn 3` — the checkpoint sequence the server diffs on. */
  readonly label: string;
  /** `3 files · +40 −12`, or the checkpoint status when it is not ready. */
  readonly detail: string;
  readonly status: OrchestrationCheckpoint["status"];
}

function turnChoiceDetail(checkpoint: OrchestrationCheckpoint): string {
  const files = checkpoint.files.length;
  let additions = 0;
  let deletions = 0;
  for (const file of checkpoint.files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  const stats = `${files} file${files === 1 ? "" : "s"} · +${additions} −${deletions}`;
  if (checkpoint.status === "missing") return `checkpoint missing · ${stats}`;
  if (checkpoint.status === "error") return `checkpoint error · ${stats}`;
  return stats;
}

/** Latest-first picker rows; turn 0 is a baseline, never a choice. */
export function turnChoices(
  checkpoints: readonly OrchestrationCheckpoint[],
): readonly TurnChoice[] {
  return checkpoints
    .filter((checkpoint) => checkpoint.checkpointTurnCount >= 1)
    .map((checkpoint) => ({
      turnId: checkpoint.turnId,
      turnCount: checkpoint.checkpointTurnCount,
      label: `Turn ${checkpoint.checkpointTurnCount}`,
      detail: turnChoiceDetail(checkpoint),
      status: checkpoint.status,
    }))
    .sort((left, right) => right.turnCount - left.turnCount);
}

/**
 * What the turn picker selected: one checkpoint's diff (`getTurnDiff`) or
 * the whole thread's accumulated diff (`getThreadDiff`).
 */
export type TurnSelection =
  | { readonly kind: "turn"; readonly turnId: string; readonly turnCount: number }
  | { readonly kind: "thread" };

/**
 * Keep the selection honest across projection updates: a reverted turn
 * falls back to the newest surviving choice, and a null selection adopts
 * the latest turn so the mode never opens empty when checkpoints exist.
 */
export function reconcileTurnSelection(
  choices: readonly TurnChoice[],
  wanted: TurnSelection | null,
): TurnSelection | null {
  if (choices.length === 0) return wanted?.kind === "thread" ? wanted : null;
  if (wanted === null) {
    const latest = choices[0];
    return latest === undefined
      ? null
      : { kind: "turn", turnId: latest.turnId, turnCount: latest.turnCount };
  }
  if (wanted.kind === "thread") return wanted;
  const found = choices.find((choice) => choice.turnId === wanted.turnId);
  if (found !== undefined) {
    return { kind: "turn", turnId: found.turnId, turnCount: found.turnCount };
  }
  const latest = choices[0];
  return latest === undefined
    ? null
    : { kind: "turn", turnId: latest.turnId, turnCount: latest.turnCount };
}

/** The capability half of the turn-mode gate — `getCapabilities` on status. */
export type OrchestrationCapabilityState =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly detail: string }
  | {
      readonly kind: "ready";
      readonly operations: Readonly<Record<string, boolean>>;
      readonly streamEpoch: string;
      readonly revision: number;
    };

/**
 * `getCapabilities` is the authority for what the turn lane may offer —
 * a missing `t3.orchestration/read` grant arrives here as the named
 * error, never as an empty capability map.
 */
export function orchestrationCapabilityState(
  capabilities: OrchestrationCapabilities | null,
  error: string | null,
): OrchestrationCapabilityState {
  if (error !== null) return { kind: "unavailable", detail: error };
  if (capabilities === null) return { kind: "loading" };
  return {
    kind: "ready",
    operations: capabilities.operations,
    streamEpoch: capabilities.streamEpoch,
    revision: capabilities.revision,
  };
}

/** The checkpoint row a revert button may target; `null` hides it. */
export function revertTarget(
  selection: TurnSelection | null,
  choices: readonly TurnChoice[],
): TurnChoice | null {
  if (selection?.kind !== "turn") return null;
  return choices.find((choice) => choice.turnId === selection.turnId) ?? null;
}

/**
 * Turn diffs arrive only over the stream — there is no unary variant and
 * no envelope cliff to detect. Reassembly still runs the full manifest /
 * ordering / sha256 verification before anything is called ready.
 */
export function fetchTurnDiff(
  stream: AsyncIterable<StreamFrameLike<VcsDiffPreviewStreamEvent>>,
  signal: AbortSignal,
): Promise<FetchOutcome<VcsDiffPreviewResult>> {
  return fetchStreamedPreview(stream, signal);
}

/** The `checkpoint.revert` input for a picker row, with the guard fields. */
export function checkpointRevertInput(
  choice: TurnChoice,
  guard: {
    readonly commandId: string;
    readonly expectedEpoch?: string;
    readonly expectedRevision?: number;
  },
): {
  readonly turnCount: number;
  readonly commandId: string;
  readonly expectedEpoch?: string;
  readonly expectedRevision?: number;
} {
  return {
    turnCount: choice.turnCount,
    commandId: guard.commandId,
    ...(guard.expectedEpoch !== undefined ? { expectedEpoch: guard.expectedEpoch } : {}),
    ...(guard.expectedRevision !== undefined ? { expectedRevision: guard.expectedRevision } : {}),
  };
}

/** Receipt text: acceptance is the contract edge; rejection carries its named error. */
export function describeRevertReceipt(receipt: OrchestrationReceipt): string {
  return receipt.status === "accepted"
    ? "Revert accepted — the workspace is being restored; later checkpoints are discarded."
    : `Revert rejected: ${receipt.error ?? "no detail reported"}`;
}
