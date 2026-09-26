/**
 * Line comments on diff lines (parity row D9). The native panel submits
 * `buildDiffReviewComment`'s record through the composer draft; this package
 * builds the same shape itself — a selection in old/new file line numbers,
 * the quoted hunk fence, and the review-row indices — and submits it through
 * `t3.messages/enrichment.attachAnnotation` (diff kind), the same seam the
 * files panel uses for its line comments. The enumeration and the label
 * format are ports of the host's `reviewCommentContext` diff-review helpers
 * over the same `@pierre/diffs` metadata; they cannot be imported (the
 * bundler bans app-private modules), so they are re-derived here.
 */

import type { FileDiffMetadata } from "@pierre/diffs/types";

import type { DiffDisplayRow } from "./viewModel.ts";

/** The `diff` string's schema bound on `attachAnnotation`; the plugin names its cap. */
export const COMMENT_QUOTE_MAX_CHARS = 4096;

/** Which side of the diff a selection endpoint anchors to (old or new file). */
export type DiffSelectionSide = "additions" | "deletions";

/**
 * A comment's anchor: `start` is a line number on `side`, `end` on `endSide`.
 * The same shape the host's `restoreDiffReviewCommentRange` reads back.
 */
export interface DiffCommentSelection {
  readonly start: number;
  readonly side: DiffSelectionSide;
  readonly end: number;
  readonly endSide: DiffSelectionSide;
}

/** One enumerated review row — `buildDiffReviewLines`' shape. */
export interface DiffReviewLine {
  readonly change: "context" | "add" | "delete";
  readonly oldLineNumber: number | null;
  readonly newLineNumber: number | null;
  readonly content: string;
}

/** Patch lines can carry a trailing newline (CRLF or LF); quoting strips it. */
function lineText(lines: readonly string[], index: number): string {
  return (lines[index] ?? "").replace(/(\r\n|\r|\n)$/, "");
}

/**
 * All review rows for a file, in order: per hunk, context segments and
 * change segments with each segment's deletions before its additions. The
 * host enumerates inter-hunk context too when the metadata is not partial;
 * this package always parses patches, so `isPartial` is always true and
 * those gaps never enumerate — on either side of the seam.
 */
export function buildDiffReviewLines(file: FileDiffMetadata): readonly DiffReviewLine[] {
  const rows: DiffReviewLine[] = [];
  for (const hunk of file.hunks) {
    let oldLineNumber = hunk.deletionStart;
    let newLineNumber = hunk.additionStart;
    let deletionLineIndex = hunk.deletionLineIndex;
    let additionLineIndex = hunk.additionLineIndex;
    for (const segment of hunk.hunkContent) {
      if (segment.type === "context") {
        for (let index = 0; index < segment.lines; index += 1) {
          rows.push({
            change: "context",
            oldLineNumber,
            newLineNumber,
            content: lineText(
              file.additionLines,
              additionLineIndex >= 0 ? additionLineIndex : deletionLineIndex,
            ),
          });
          oldLineNumber += 1;
          newLineNumber += 1;
          deletionLineIndex += 1;
          additionLineIndex += 1;
        }
        continue;
      }
      for (let index = 0; index < segment.deletions; index += 1) {
        rows.push({
          change: "delete",
          oldLineNumber,
          newLineNumber: null,
          content: lineText(file.deletionLines, deletionLineIndex),
        });
        oldLineNumber += 1;
        deletionLineIndex += 1;
      }
      for (let index = 0; index < segment.additions; index += 1) {
        rows.push({
          change: "add",
          oldLineNumber: null,
          newLineNumber,
          content: lineText(file.additionLines, additionLineIndex),
        });
        newLineNumber += 1;
        additionLineIndex += 1;
      }
    }
  }
  return rows;
}

/**
 * The review-row index of a file line on one side only, -1 when the line is
 * not in the diff on that side. Building a new comment always resolves
 * through this strict form: display rows include expanded gap context the
 * patch never enumerated, and a hit on the same side is always that exact
 * file line, while the cross-side fallback below could bind an unrelated
 * line that happens to carry the same number on the other side.
 */
export function findDiffReviewLineIndexOnSide(
  file: FileDiffMetadata,
  lineNumber: number,
  side: DiffSelectionSide,
): number {
  const selectedSide = side === "deletions" ? "left" : "right";
  let rowIndex = 0;
  for (const hunk of file.hunks) {
    let oldLineNumber = hunk.deletionStart;
    let newLineNumber = hunk.additionStart;
    for (const segment of hunk.hunkContent) {
      if (segment.type === "context") {
        const start = selectedSide === "left" ? oldLineNumber : newLineNumber;
        if (lineNumber >= start && lineNumber < start + segment.lines) {
          return rowIndex + lineNumber - start;
        }
        rowIndex += segment.lines;
        oldLineNumber += segment.lines;
        newLineNumber += segment.lines;
        continue;
      }
      if (
        selectedSide === "left" &&
        lineNumber >= oldLineNumber &&
        lineNumber < oldLineNumber + segment.deletions
      ) {
        return rowIndex + lineNumber - oldLineNumber;
      }
      rowIndex += segment.deletions;
      oldLineNumber += segment.deletions;
      if (
        selectedSide === "right" &&
        lineNumber >= newLineNumber &&
        lineNumber < newLineNumber + segment.additions
      ) {
        return rowIndex + lineNumber - newLineNumber;
      }
      rowIndex += segment.additions;
      newLineNumber += segment.additions;
    }
  }
  return -1;
}

/**
 * The review-row index of a file line on one side, -1 when the line is not
 * in the diff. The host's cross-side fallback is preserved: a context line
 * selected on its missing side resolves on the other. This is the restore
 * path's shape (the host's `restoreDiffReviewCommentRange`); building new
 * comments uses the strict `findDiffReviewLineIndexOnSide` above.
 */
export function findDiffReviewLineIndex(
  file: FileDiffMetadata,
  lineNumber: number,
  side: DiffSelectionSide,
): number {
  const preferred = findDiffReviewLineIndexOnSide(file, lineNumber, side);
  return preferred >= 0
    ? preferred
    : findDiffReviewLineIndexOnSide(
        file,
        lineNumber,
        side === "deletions" ? "additions" : "deletions",
      );
}

/** `+5`, `+5 to +9` — the native `formatDiffReviewRangeLabel`. */
export function formatDiffReviewRangeLabel(lines: readonly DiffReviewLine[]): string {
  const firstLine = lines[0];
  const lastLine = lines.at(-1);
  if (firstLine === undefined || lastLine === undefined) return "line";
  const firstNumber = firstLine.newLineNumber ?? firstLine.oldLineNumber;
  const lastNumber = lastLine.newLineNumber ?? lastLine.oldLineNumber;
  if (firstNumber === null || lastNumber === null) {
    return lines.length === 1 ? "line" : `${lines.length} lines`;
  }
  const marker = (line: DiffReviewLine): string => {
    const change = line.change === "add" ? "+" : line.change === "delete" ? "-" : "";
    return change !== "" && lines.every((entry) => entry.change === line.change) ? change : "";
  };
  const prefix = marker(firstLine);
  return firstNumber === lastNumber
    ? `${prefix}${firstNumber}`
    : `${prefix}${firstNumber} to ${prefix}${lastNumber}`;
}

/**
 * The host's exact rule, mirrored: a `<` that would open or close a
 * `review_comment` tag becomes `&lt;`. Quoted diff lines are file content —
 * whoever wrote the file chose them — and they travel inside the serialized
 * annotation block, so a quoted `</review_comment>` would truncate it and a
 * quoted opening tag could forge another attachment naming any file it
 * liked. The host neutralizes again at serialization; neutralizing at this
 * side of the seam means the quote is safe whatever a host build does with
 * it, and idempotent when both sides run.
 */
export function neutralizeReviewCommentTags(text: string): string {
  return text.replace(/<(?=\/?review_comment\b)/giu, "&lt;");
}

function markerFor(change: DiffReviewLine["change"]): string {
  return change === "add" ? "+" : change === "delete" ? "-" : " ";
}

/** First numbered line + how many numbered lines — the native `getDiffRange`. */
function sideRange(lines: readonly DiffReviewLine[], key: "oldLineNumber" | "newLineNumber") {
  const numbered = lines.filter((line) => line[key] !== null);
  return { start: numbered[0]?.[key] ?? 0, count: numbered.length };
}

/** The `@@ -old,count +new,count @@` header over a set of quoted lines. */
function quoteHeader(lines: readonly DiffReviewLine[]): string {
  const old = sideRange(lines, "oldLineNumber");
  const added = sideRange(lines, "newLineNumber");
  return `@@ -${old.start},${old.count} +${added.start},${added.count} @@`;
}

/**
 * The quoted line one review row contributes: the plugin's own marker (never
 * taken from content) prefixing the neutralized line.
 */
function quoteLine(line: DiffReviewLine): string {
  return `${markerFor(line.change)}${neutralizeReviewCommentTags(line.content)}`;
}

/** Surrogate-safe cut: never split a UTF-16 pair (the files pack's excerpt rule). */
function cutOnCharacterBoundary(text: string, maxChars: number): string {
  const cut = Math.max(0, maxChars);
  if (text.length <= cut) return text;
  const codeUnit = text.charCodeAt(cut - 1);
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff ? text.slice(0, cut - 1) : text.slice(0, cut);
}

/** A comment target the display rows produced: selection + indices + quote. */
export interface DiffCommentTarget {
  readonly selection: DiffCommentSelection;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly rangeLabel: string;
  readonly quote: string;
  readonly truncated: boolean;
}

/**
 * Build the annotation payload for a contiguous run of display rows, or null
 * when the run's boundary rows carry no anchorable line. Side preference
 * follows the row kind — deletions anchor left, additions and context right
 * — so a run from a deletion to an addition selects across the pairing, the
 * native drag shape. Rows spliced in by gap expansion carry file line
 * numbers the patch never enumerated; they anchor only when that exact line
 * is genuinely in a hunk on its own side, never through the cross-side
 * fallback — that could quote an unrelated line with the same number. The
 * quote caps at `maxQuoteChars` (the schema's `diff` bound): whole lines are
 * kept from the head while they fit, a monster first line is cut on a
 * character boundary, and `truncated` discloses either. The label always
 * names the full selection.
 */
export function buildDiffCommentTarget(options: {
  readonly file: FileDiffMetadata;
  readonly rows: readonly DiffDisplayRow[];
  readonly startOrdinal: number;
  readonly endOrdinal: number;
  readonly maxQuoteChars?: number;
}): DiffCommentTarget | null {
  const { file, rows } = options;
  const maxQuoteChars = options.maxQuoteChars ?? COMMENT_QUOTE_MAX_CHARS;
  const start = rows[Math.min(options.startOrdinal, options.endOrdinal)];
  const end = rows[Math.max(options.startOrdinal, options.endOrdinal)];
  if (start === undefined || end === undefined) return null;
  if (start.kind === "gap" || end.kind === "gap") return null;

  const startPoint =
    start.kind === "deletion"
      ? { line: start.oldLine, side: "deletions" as const }
      : { line: start.newLine, side: "additions" as const };
  const endPoint =
    end.kind === "deletion"
      ? { line: end.oldLine, side: "deletions" as const }
      : { line: end.newLine, side: "additions" as const };

  const startIndex = findDiffReviewLineIndexOnSide(file, startPoint.line, startPoint.side);
  const endIndex = findDiffReviewLineIndexOnSide(file, endPoint.line, endPoint.side);
  if (startIndex < 0 || endIndex < 0) return null;

  const lo = Math.min(startIndex, endIndex);
  const hi = Math.max(startIndex, endIndex);
  const selected = buildDiffReviewLines(file).slice(lo, hi + 1);
  if (selected.length === 0) return null;

  const rangeLabel = formatDiffReviewRangeLabel(selected);
  const quoted = selected.map(quoteLine);
  // Single pass over the candidates: each side's header start is set by the
  // first numbered line it meets and its count only grows, so every
  // candidate's length falls out of running counters. Re-slicing per
  // candidate was quadratic, and a wide selection builds this on the click.
  let oldStart: number | null = null;
  let newStart: number | null = null;
  let oldCount = 0;
  let newCount = 0;
  let quotedLength = 0;
  let keep = 0;
  for (let index = 0; index < selected.length; index += 1) {
    const line = selected[index];
    if (line === undefined) break;
    if (line.oldLineNumber !== null) {
      if (oldStart === null) oldStart = line.oldLineNumber;
      oldCount += 1;
    }
    if (line.newLineNumber !== null) {
      if (newStart === null) newStart = line.newLineNumber;
      newCount += 1;
    }
    quotedLength += (quoted[index] ?? "").length + (index > 0 ? 1 : 0);
    const headerLength = `@@ -${oldStart ?? 0},${oldCount} +${newStart ?? 0},${newCount} @@`.length;
    if (headerLength + 1 + quotedLength > maxQuoteChars) break;
    keep = index + 1;
  }
  let quote: string;
  let truncated = keep < quoted.length;
  if (keep > 0) {
    quote = [quoteHeader(selected.slice(0, keep)), ...quoted.slice(0, keep)].join("\n");
  } else {
    // Not even one whole line fits: cut the first line's content, never a
    // marker or the header, and never mid-surrogate.
    const header = quoteHeader(selected.slice(0, 1));
    const budget = maxQuoteChars - header.length - 1 - 1;
    if (budget < 1) return null;
    quote = [header, cutOnCharacterBoundary(quoted[0] ?? "", budget)].join("\n");
    truncated = true;
  }
  return {
    selection: {
      start: startPoint.line,
      side: startPoint.side,
      end: endPoint.line,
      endSide: endPoint.side,
    },
    startIndex: lo,
    endIndex: hi,
    rangeLabel,
    quote,
    truncated,
  };
}

export interface CommentTransportCapabilities {
  readonly transport: string;
  readonly detail: string | null;
  readonly operations: { readonly attachAnnotation?: boolean };
}

/**
 * Why commenting is unavailable, or null when the action can run. A
 * non-client transport names a host without a connected client; a missing
 * thread scope means this panel has no draft to write into. Grant denial is
 * not knowable here — it surfaces as the invoke's named error at submit.
 */
export function commentUnavailableReason(
  capabilities: CommentTransportCapabilities,
  threadId: string | undefined,
): string | null {
  if (threadId === undefined)
    return "This panel has no thread scope, so there is no draft to comment into.";
  if (capabilities.transport !== "client" || capabilities.operations.attachAnnotation !== true) {
    return (
      capabilities.detail ?? "Commenting needs a connected client hosting the composer provider."
    );
  }
  return null;
}
