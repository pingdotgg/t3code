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

interface ParsedListMarker {
  marker: ListMarker;
  markerEnd: number;
  /** Column a nested item must reach to belong to this item. */
  contentColumn: number;
}

function parseListMarker(line: string): ParsedListMarker | null {
  const indent = line.match(/^[ \t]*/)?.[0] ?? "";
  const rest = line.slice(indent.length);
  const ordered = rest.match(/^(\d+)([.)])((?:[ \t]+)|\s*$)/);
  if (ordered && ordered[1] !== undefined && ordered[2] !== undefined) {
    const space = ordered[3] ?? "";
    return {
      marker: {
        kind: "ordered",
        indent,
        numberText: ordered[1],
        delimiter: ordered[2] === ")" ? ")" : ".",
        space,
      },
      markerEnd: indent.length + ordered[0].length,
      contentColumn: contentColumn(indent, ordered[1].length + 1, space),
    };
  }
  // The checkbox is item content, so a task's content starts after "- ".
  const task = rest.match(/^-(\s)\[[ xX]\]((?:[ \t]+)|\s*$)/);
  if (task && task[1] !== undefined) {
    return {
      marker: { kind: "task", indent, space: task[2] ?? "" },
      markerEnd: indent.length + task[0].length,
      contentColumn: contentColumn(indent, 1, task[1]),
    };
  }
  const bullet = rest.match(/^([-*+])((?:[ \t]+)|\s*$)/);
  if (bullet && bullet[1] !== undefined) {
    const space = bullet[2] ?? "";
    return {
      marker: { kind: "bullet", indent, bullet: bullet[1], space },
      markerEnd: indent.length + bullet[0].length,
      contentColumn: contentColumn(indent, 1, space),
    };
  }
  return null;
}

// CommonMark content follows 1-4 columns of padding; wider padding is code, so the content
// column sits one column past the marker.
function contentColumn(indent: string, markerWidth: number, padding: string): number {
  const markerEnd = indentWidth(indent) + markerWidth;
  const space = indentWidth(padding, markerEnd);
  return markerEnd + (space >= 1 && space <= 4 ? space : 1);
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

// Markdown tabs advance to the next four-column stop.
function indentWidth(line: string, fromColumn = 0): number {
  let column = fromColumn;
  for (const char of line) {
    if (char === " ") column += 1;
    else if (char === "\t") column += 4 - (column % 4);
    else break;
  }
  return column - fromColumn;
}

function renumberFollowingItems(
  value: string,
  afterLineEnd: number,
  marker: Extract<ListMarker, { kind: "ordered" }>,
  tokens: ReturnType<typeof inlineTokenRanges>,
): { end: number; text: string } | null {
  const baseWidth = indentWidth(marker.indent);
  const parts: string[] = [];
  let expected = Number.parseInt(marker.numberText, 10) + 2;
  let position = afterLineEnd;
  let copiedUntil = afterLineEnd;
  let tokenIndex = 0;
  while (position < value.length && Number.isSafeInteger(expected)) {
    const lineStart = position + 1;
    const nextBreak = value.indexOf("\n", lineStart);
    const lineEnd = nextBreak === -1 ? value.length : nextBreak;
    position = lineEnd;
    let token = tokens[tokenIndex];
    while (token && token.end <= lineStart) {
      tokenIndex += 1;
      token = tokens[tokenIndex];
    }
    // A newline inside a chip does not start a list item.
    if (token && token.start < lineStart) continue;

    const line = value.slice(lineStart, lineEnd);
    const width = indentWidth(line);
    if (line.trim() === "" || width < baseWidth) break;
    if (width > baseWidth) continue;
    const parsed = parseListMarker(line);
    if (parsed?.marker.kind !== "ordered" || parsed.marker.delimiter !== marker.delimiter) break;

    const current = parsed.marker;
    const numberStart = lineStart + current.indent.length;
    const numberEnd = numberStart + current.numberText.length;
    const replacement = current.numberText.startsWith("0")
      ? String(expected).padStart(current.numberText.length, "0")
      : String(expected);
    if (replacement !== current.numberText) {
      parts.push(value.slice(copiedUntil, numberStart), replacement);
      copiedUntil = numberEnd;
    }
    expected += 1;
  }
  return parts.length === 0 ? null : { end: copiedUntil, text: parts.join("") };
}

function inlineTokenRanges(value: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let offset = 0;
  for (const segment of splitPromptIntoComposerSegments(value)) {
    const end = offset + (segment.type === "text" ? segment.text : segment.source).length;
    if (segment.type !== "text") ranges.push({ start: offset, end });
    offset = end;
  }
  return ranges;
}

function isInsideInlineToken(
  tokens: ReturnType<typeof inlineTokenRanges>,
  cursor: number,
): boolean {
  return tokens.some((range) => cursor > range.start && cursor < range.end);
}

function currentLine(value: string, cursor: number): { start: number; end: number; text: string } {
  const start = value.lastIndexOf("\n", cursor - 1) + 1;
  const endIndex = value.indexOf("\n", cursor);
  const end = endIndex === -1 ? value.length : endIndex;
  return { start, end, text: value.slice(start, end) };
}

function* listMarkersAbove(
  value: string,
  lineStart: number,
  tokens: ReturnType<typeof inlineTokenRanges>,
): Generator<ParsedListMarker> {
  let tokenIndex = tokens.length - 1;
  while (lineStart > 0) {
    const lineEnd = lineStart - 1;
    lineStart = value.lastIndexOf("\n", lineEnd - 1) + 1;
    // A newline inside a chip does not start a list item.
    for (let token = tokens[tokenIndex]; token; token = tokens[tokenIndex]) {
      if (token.start >= lineStart) tokenIndex -= 1;
      else if (token.end > lineStart) lineStart = value.lastIndexOf("\n", token.start - 1) + 1;
      else break;
    }
    const parsed = parseListMarker(value.slice(lineStart, lineEnd));
    if (!parsed) return;
    yield parsed;
  }
}

function parentMarker(
  value: string,
  lineStart: number,
  marker: ListMarker,
  tokens: ReturnType<typeof inlineTokenRanges>,
): ListMarker | null {
  const width = indentWidth(marker.indent);
  for (const above of listMarkersAbove(value, lineStart, tokens)) {
    if (indentWidth(above.marker.indent) < width) return above.marker;
  }
  return null;
}

function nestedNumber(
  marker: ListMarker,
  previousChild: ListMarker | undefined,
): { replacedLength: number; text: string } {
  if (marker.kind !== "ordered") return { replacedLength: 0, text: "" };
  const continues =
    previousChild?.kind === "ordered" && previousChild.delimiter === marker.delimiter;
  return {
    replacedLength: marker.numberText.length,
    text: continues
      ? nextOrderedMarkerText(`${previousChild.numberText}${marker.delimiter}`).slice(0, -1)
      : "1",
  };
}

export function listContinuationForEnter(value: string, cursor: number): ComposerListEdit | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > value.length) return null;
  const line = currentLine(value, cursor);
  const parsed = parseListMarker(line.text);
  if (!parsed || parsed.marker.space === "") return null;
  const markerEnd = line.start + parsed.markerEnd;
  if (cursor < markerEnd) return null;
  const tokens = inlineTokenRanges(value);
  if (isInsideInlineToken(tokens, cursor)) return null;
  if (value.slice(markerEnd, line.end).trim() === "") {
    const parent = parentMarker(value, line.start, parsed.marker, tokens);
    const replacement = parent ? nextMarkerText(parent) : "";
    const cursorAfter = line.start + replacement.length;
    const end = Math.max(cursor, markerEnd);
    const renumbered =
      parent?.kind === "ordered" ? renumberFollowingItems(value, line.end, parent, tokens) : null;
    if (renumbered) {
      return {
        start: line.start,
        end: renumbered.end,
        replacement: replacement + value.slice(end, line.end) + renumbered.text,
        cursorAfter,
      };
    }
    return { start: line.start, end, replacement, cursorAfter };
  }
  const insertion = `\n${nextMarkerText(parsed.marker)}`;
  const cursorAfter = cursor + insertion.length;
  const { marker } = parsed;
  if (marker.kind === "ordered") {
    const renumbered = renumberFollowingItems(value, line.end, marker, tokens);
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
  const parsed = parseListMarker(line.text);
  if (!parsed) return null;
  const tokens = inlineTokenRanges(value);
  if (isInsideInlineToken(tokens, start)) return null;
  const { marker } = parsed;
  const width = indentWidth(marker.indent);
  let previousChild: ListMarker | undefined;
  for (const above of listMarkersAbove(value, line.start, tokens)) {
    const aboveWidth = indentWidth(above.marker.indent);
    if (aboveWidth < width) break;
    if (aboveWidth > width) {
      if (!previousChild || aboveWidth < indentWidth(previousChild.indent)) {
        previousChild = above.marker;
      }
      continue;
    }
    const indent =
      previousChild?.indent ?? above.marker.indent + " ".repeat(above.contentColumn - aboveWidth);
    const number = nestedNumber(marker, previousChild);
    const replacedEnd = line.start + marker.indent.length + number.replacedLength;
    const replacement = indent + number.text;
    return {
      start: line.start,
      end: replacedEnd,
      replacement,
      cursorAfter:
        start < replacedEnd
          ? line.start + indent.length
          : start - replacedEnd + line.start + replacement.length,
    };
  }
  return { start: line.start, end: line.start, replacement: "  ", cursorAfter: start + 2 };
}
