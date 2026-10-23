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
  start: number,
  tokens: ReturnType<typeof inlineTokenRanges>,
) {
  let tokenIndex = tokens.length - 1;
  while (start > 0) {
    let lineStart = value.lastIndexOf("\n", start - 2) + 1;
    // A newline inside a chip does not start a list item.
    for (let token = tokens[tokenIndex]; token; token = tokens[tokenIndex]) {
      if (token.start >= lineStart) tokenIndex -= 1;
      else if (token.end > lineStart) lineStart = value.lastIndexOf("\n", token.start - 1) + 1;
      else break;
    }
    const parsed = parseListMarker(value.slice(lineStart, start - 1));
    if (!parsed) return;
    yield parsed.marker;
    start = lineStart;
  }
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
    // An empty nested item lifts to its parent's level before leaving the list.
    const { indent } = parsed.marker;
    let parent: ListMarker | undefined;
    if (indent !== "") {
      for (const above of listMarkersAbove(value, line.start, tokens)) {
        if (above.indent.length < indent.length && indent.startsWith(above.indent)) {
          parent = above;
          break;
        }
      }
    }
    const replacement = parent ? nextMarkerText(parent) : "";
    return {
      start: line.start,
      end: Math.max(cursor, markerEnd),
      replacement,
      cursorAfter: line.start + replacement.length,
    };
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
  let lastChild: ListMarker | undefined;
  for (const above of listMarkersAbove(value, line.start, tokens)) {
    if (above.indent.length > marker.indent.length && above.indent.startsWith(marker.indent)) {
      if (!lastChild || above.indent.length < lastChild.indent.length) lastChild = above;
      continue;
    }
    if (above.indent !== marker.indent) break;

    // CommonMark children must reach the parent's content column. A task's box is content.
    const markerWidth = above.kind === "ordered" ? above.numberText.length + 1 : 1;
    const space = indentWidth(above.space, indentWidth(above.indent) + markerWidth);
    const childWidth =
      above.kind === "task" ? 2 : markerWidth + (space >= 1 && space <= 4 ? space : 1);
    const indent = lastChild?.indent ?? above.indent + " ".repeat(childWidth);
    const sibling =
      marker.kind === "ordered" &&
      lastChild?.kind === "ordered" &&
      lastChild.delimiter === marker.delimiter
        ? lastChild
        : null;
    const numberText = sibling
      ? nextOrderedMarkerText(sibling.numberText + sibling.delimiter).slice(0, -1)
      : "1";
    const editEnd =
      line.start +
      marker.indent.length +
      (marker.kind === "ordered" ? marker.numberText.length : 0);
    const replacement = indent + (marker.kind === "ordered" ? numberText : "");
    const shift = replacement.length - (editEnd - line.start);
    return {
      start: line.start,
      end: editEnd,
      replacement,
      cursorAfter: start >= editEnd ? start + shift : line.start + indent.length,
    };
  }
  return { start: line.start, end: line.start, replacement: "  ", cursorAfter: start + 2 };
}
