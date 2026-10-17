import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";

export interface ComposerListEdit {
  start: number;
  end: number;
  replacement: string;
  /** Expanded caret offset after the edit is applied. */
  cursorAfter: number;
}

type ListMarker =
  | { kind: "ordered"; indent: string; numberText: string; delimiter: "." | ")"; space: string }
  | { kind: "task"; indent: string; space: string }
  | { kind: "bullet"; indent: string; bullet: string; space: string };

function parseListMarker(line: string): { marker: ListMarker; markerEnd: number } | null {
  const indent = line.match(/^[ \t]*/)?.[0] ?? "";
  const rest = line.slice(indent.length);
  const ordered = rest.match(/^(\d+)([.)])((?:[ \t]+)|\s*$)/);
  if (ordered && ordered[1] !== undefined && ordered[2] !== undefined) {
    return {
      marker: {
        kind: "ordered",
        indent,
        numberText: ordered[1],
        delimiter: ordered[2] === ")" ? ")" : ".",
        space: ordered[3] ?? "",
      },
      markerEnd: indent.length + ordered[0].length,
    };
  }
  const task = rest.match(/^-\s\[[ xX]\]((?:[ \t]+)|\s*$)/);
  if (task) {
    return {
      marker: { kind: "task", indent, space: task[1] ?? "" },
      markerEnd: indent.length + task[0].length,
    };
  }
  const bullet = rest.match(/^([-*+])((?:[ \t]+)|\s*$)/);
  if (bullet && bullet[1] !== undefined) {
    return {
      marker: { kind: "bullet", indent, bullet: bullet[1], space: bullet[2] ?? "" },
      markerEnd: indent.length + bullet[0].length,
    };
  }
  return null;
}

export function nextOrderedMarkerText(marker: string): string {
  const numberText = marker.slice(0, -1);
  const delimiter = marker.slice(-1);
  const number = Number.parseInt(numberText, 10);
  const next = Number.isSafeInteger(number)
    ? String(number + 1).padStart(numberText.length, "0")
    : numberText;
  return `${next}${delimiter}`;
}

function nextMarkerText(marker: ListMarker): string {
  if (marker.kind === "ordered") {
    return `${marker.indent}${nextOrderedMarkerText(`${marker.numberText}${marker.delimiter}`)} `;
  }
  if (marker.kind === "task") {
    return `${marker.indent}- [ ] `;
  }
  return `${marker.indent}${marker.bullet} `;
}

function formatOrderedNumber(value: number, numberText: string): string {
  if (!Number.isSafeInteger(value)) return numberText;
  // Keep the width only for explicitly zero-padded markers ("01.").
  return numberText.startsWith("0")
    ? String(value).padStart(numberText.length, "0")
    : String(value);
}

/** Visual indent width with tabs expanded to four-column stops, as in CommonMark. */
function indentWidth(indent: string): number {
  let width = 0;
  for (const char of indent) width = char === "\t" ? width + 4 - (width % 4) : width + 1;
  return width;
}

/**
 * Renumber the ordered items that follow `afterLineEnd` so a newly inserted
 * item does not leave duplicates below it. Walks the contiguous run of
 * same-indent, same-delimiter items (skipping deeper-indented children) and
 * stops at the first line that is not part of that run. Returns the end
 * offset of the last renumbered marker and the replacement for the text
 * between `afterLineEnd` and that offset.
 */
function renumberFollowingItems(
  value: string,
  afterLineEnd: number,
  marker: Extract<ListMarker, { kind: "ordered" }>,
  firstNumber: number,
): { end: number; text: string } | null {
  const tokens = inlineTokenRanges(value);
  const baseWidth = indentWidth(marker.indent);
  let expected = firstNumber;
  let position = afterLineEnd;
  let end = -1;
  let text = "";
  let copiedUntil = afterLineEnd;
  while (position < value.length) {
    const lineStart = position + 1;
    const nextBreak = value.indexOf("\n", lineStart);
    const lineEnd = nextBreak === -1 ? value.length : nextBreak;
    position = lineEnd;
    // A line that starts inside a multiline chip is part of that chip's text.
    if (tokens.some((token) => lineStart > token.start && lineStart < token.end)) continue;
    const line = value.slice(lineStart, lineEnd);
    const parsed = parseListMarker(line);
    const width = indentWidth(line.match(/^[ \t]*/)?.[0] ?? "");
    if (
      parsed?.marker.kind === "ordered" &&
      width === baseWidth &&
      parsed.marker.delimiter === marker.delimiter
    ) {
      const current = parsed.marker;
      const numberStart = lineStart + current.indent.length;
      const numberEnd = numberStart + current.numberText.length;
      const replacement = formatOrderedNumber(expected, current.numberText);
      if (replacement !== current.numberText) {
        text += value.slice(copiedUntil, numberStart) + replacement;
        copiedUntil = numberEnd;
        end = numberEnd;
      }
      expected += 1;
    } else if (line.trim() === "" || width <= baseWidth) {
      break;
    }
  }
  return end === -1 ? null : { end, text };
}

function segmentSource(
  segment: ReturnType<typeof splitPromptIntoComposerSegments>[number],
): string {
  if (segment.type === "text") return segment.text;
  return segment.source;
}

function inlineTokenRanges(value: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let offset = 0;
  for (const segment of splitPromptIntoComposerSegments(value)) {
    const end = offset + segmentSource(segment).length;
    if (segment.type !== "text") ranges.push({ start: offset, end });
    offset = end;
  }
  return ranges;
}

/** True when splitting at the caret would cut an inline chip in two. */
function isInsideInlineToken(value: string, cursor: number): boolean {
  return inlineTokenRanges(value).some((range) => cursor > range.start && cursor < range.end);
}

function currentLine(value: string, cursor: number): { start: number; end: number; text: string } {
  const start = value.lastIndexOf("\n", cursor - 1) + 1;
  const endIndex = value.indexOf("\n", cursor);
  const end = endIndex === -1 ? value.length : endIndex;
  return { start, end, text: value.slice(start, end) };
}

export function listContinuationForEnter(value: string, cursor: number): ComposerListEdit | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > value.length) return null;
  const line = currentLine(value, cursor);
  const parsed = parseListMarker(line.text);
  if (!parsed) return null;
  const markerEnd = line.start + parsed.markerEnd;
  if (cursor < markerEnd) return null;
  if (isInsideInlineToken(value, cursor)) return null;
  if (value.slice(markerEnd, line.end).trim() === "") {
    return {
      start: line.start,
      end: Math.max(cursor, markerEnd),
      replacement: "",
      cursorAfter: line.start,
    };
  }
  const insertion = `\n${nextMarkerText(parsed.marker)}`;
  const cursorAfter = cursor + insertion.length;
  const { marker } = parsed;
  if (marker.kind === "ordered") {
    const number = Number.parseInt(marker.numberText, 10);
    const renumbered = Number.isSafeInteger(number)
      ? renumberFollowingItems(value, line.end, marker, number + 2)
      : null;
    if (renumbered) {
      return {
        start: cursor,
        end: renumbered.end,
        replacement: insertion + value.slice(cursor, line.end) + renumbered.text,
        cursorAfter,
      };
    }
  }
  return { start: cursor, end: cursor, replacement: insertion, cursorAfter };
}

export function listIndentForTab(
  value: string,
  start: number,
  end: number,
): ComposerListEdit | null {
  if (!Number.isInteger(start) || start !== end || start < 0 || start > value.length) return null;
  const line = currentLine(value, start);
  if (!parseListMarker(line.text)) return null;
  if (isInsideInlineToken(value, start)) return null;
  return { start: line.start, end: line.start, replacement: "  ", cursorAfter: start + 2 };
}
