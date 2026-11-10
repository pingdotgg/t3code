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

type OrderedMarker = Extract<ListMarker, { kind: "ordered" }>;
type NumberedRun = { marker: OrderedMarker; first: number };

function markerNumber(marker: OrderedMarker): number {
  return Number.parseInt(marker.numberText, 10);
}

function continuesOrderedList(
  marker: ListMarker | null | undefined,
  next: ListMarker,
): marker is OrderedMarker {
  return (
    marker?.kind === "ordered" && next.kind === "ordered" && marker.delimiter === next.delimiter
  );
}

// A run stops at the line that ends it, and the next, shallower run reads on from that line.
function extendWithRenumbering(
  value: string,
  tokens: ReturnType<typeof inlineTokenRanges>,
  edit: ComposerListEdit,
  afterLineEnd: number,
  runs: ReadonlyArray<NumberedRun>,
): ComposerListEdit {
  const parts: string[] = [];
  let position = afterLineEnd;
  let copiedUntil = afterLineEnd;
  let tokenIndex = 0;
  for (const { marker, first } of runs) {
    const baseWidth = indentWidth(marker.indent);
    let expected = first;
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
      if (line.trim() === "" || width < baseWidth) {
        position = lineStart - 1;
        break;
      }
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
  }
  if (parts.length === 0) return edit;
  return {
    ...edit,
    end: copiedUntil,
    replacement: edit.replacement + value.slice(edit.end, afterLineEnd) + parts.join(""),
  };
}

// `edit` rewrites the lifted line from its start. Siblings left at or past the lifted item's new
// content column become its children, numbered from 1; `parentList` counts on after it.
function renumberAfterLift(
  value: string,
  tokens: ReturnType<typeof inlineTokenRanges>,
  edit: ComposerListEdit,
  lineEnd: number,
  lifted: ListMarker,
  parentList: ListMarker | null,
): ComposerListEdit {
  const runs: NumberedRun[] = [];
  if (lifted.kind === "ordered") {
    const liftedTo = parseListMarker(edit.replacement + value.slice(edit.end, lineEnd));
    if (liftedTo && indentWidth(lifted.indent) >= liftedTo.contentColumn) {
      runs.push({ marker: lifted, first: 1 });
    }
  }
  if (parentList?.kind === "ordered") {
    runs.push({ marker: parentList, first: markerNumber(parentList) + 2 });
  }
  return extendWithRenumbering(value, tokens, edit, lineEnd, runs);
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
  return {
    replacedLength: marker.numberText.length,
    text: continuesOrderedList(previousChild, marker)
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
    const edit = {
      start: line.start,
      end: Math.max(cursor, markerEnd),
      replacement,
      cursorAfter: line.start + replacement.length,
    };
    return parent ? renumberAfterLift(value, tokens, edit, line.end, parsed.marker, parent) : edit;
  }
  const insertion = `\n${nextMarkerText(parsed.marker)}`;
  const edit = {
    start: cursor,
    end: cursor,
    replacement: insertion,
    cursorAfter: cursor + insertion.length,
  };
  const { marker } = parsed;
  return marker.kind === "ordered"
    ? extendWithRenumbering(value, tokens, edit, line.end, [
        { marker, first: markerNumber(marker) + 2 },
      ])
    : edit;
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
    const edit = {
      start: line.start,
      end: replacedEnd,
      replacement,
      cursorAfter:
        start < replacedEnd
          ? line.start + indent.length
          : start - replacedEnd + line.start + replacement.length,
    };
    return continuesOrderedList(above.marker, marker)
      ? extendWithRenumbering(value, tokens, edit, line.end, [
          { marker: above.marker, first: markerNumber(above.marker) + 1 },
        ])
      : edit;
  }
  return { start: line.start, end: line.start, replacement: "  ", cursorAfter: start + 2 };
}

export function listOutdentForTab(
  value: string,
  start: number,
  end: number,
): ComposerListEdit | null {
  if (!Number.isInteger(start) || start !== end || start < 0 || start > value.length) return null;
  const line = currentLine(value, start);
  const parsed = parseListMarker(line.text);
  if (!parsed?.marker.indent) return null;
  const tokens = inlineTokenRanges(value);
  if (isInsideInlineToken(tokens, start)) return null;
  const { marker } = parsed;
  const parent = parentMarker(value, line.start, marker, tokens);
  // With no parent above, undo one step of Tab's two-space fallback.
  const indent = parent?.indent ?? marker.indent.replace(/^(?:\t| {1,2})/, "");
  const continues = continuesOrderedList(parent, marker);
  const number = continues ? nestedNumber(marker, parent) : { replacedLength: 0, text: "" };
  const replacedEnd = line.start + marker.indent.length + number.replacedLength;
  const replacement = indent + number.text;
  const edit = {
    start: line.start,
    end: replacedEnd,
    replacement,
    cursorAfter:
      start < replacedEnd
        ? line.start + indent.length
        : start - replacedEnd + line.start + replacement.length,
  };
  return parent
    ? renumberAfterLift(value, tokens, edit, line.end, marker, continues ? parent : null)
    : edit;
}
