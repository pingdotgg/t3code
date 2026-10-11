import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";

/**
 * List continuation and indentation for the composer.
 *
 * Implemented once at the ChatComposer level (store replacement), so both
 * composer modes behave identically and serialize identically:
 * Shift+Enter on a list item continues it, Enter on an empty item leaves one
 * level of nesting (or the list), and Tab nests the item under the one above.
 * Plain Markdown markers only — no real list nodes anywhere.
 */

export interface ComposerListEdit {
  /** Expanded (plain string) offsets into the prompt. */
  start: number;
  end: number;
  replacement: string;
  /** Expanded caret after the edit; defaults to the end of the replacement. */
  cursor?: number;
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

/**
 * The ordered marker that follows `3.` or `09)`: one higher, same delimiter,
 * zero padding kept, and a number too large to count left as typed. Shared
 * with the rich editor's native split so both modes count the same way.
 */
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

function segmentSource(
  segment: ReturnType<typeof splitPromptIntoComposerSegments>[number],
): string {
  if (segment.type === "text") return segment.text;
  return segment.source;
}

/** True when splitting at the caret would cut an inline chip in two. */
function isInsideInlineToken(value: string, cursor: number): boolean {
  let offset = 0;
  for (const segment of splitPromptIntoComposerSegments(value)) {
    const end = offset + segmentSource(segment).length;
    if (segment.type !== "text" && cursor > offset && cursor < end) return true;
    offset = end;
  }
  return false;
}

interface Line {
  start: number;
  end: number;
  text: string;
}

function currentLine(value: string, cursor: number): Line {
  const start = value.lastIndexOf("\n", cursor - 1) + 1;
  const endIndex = value.indexOf("\n", cursor);
  const end = endIndex === -1 ? value.length : endIndex;
  return { start, end, text: value.slice(start, end) };
}

/** The list lines directly above `line`, nearest first, up to the first non-list line. */
function* listLinesAbove(value: string, line: Line): Generator<ListMarker> {
  let start = line.start;
  while (start > 0) {
    const previous = currentLine(value, start - 1);
    const parsed = parseListMarker(previous.text);
    if (!parsed) return;
    yield parsed.marker;
    start = previous.start;
  }
}

function isDeeper(indent: string, than: string): boolean {
  return indent.length > than.length && indent.startsWith(than);
}

/**
 * How far a child must be indented to nest under this item: its content
 * column, as CommonMark counts it. Two spaces under `1. ` would read as a
 * sibling, so the agent would get a flat list.
 */
function childIndentWidth(marker: ListMarker): number {
  // A task's box is item content, so its children nest under the dash.
  if (marker.kind === "task") return 2;
  const markerText =
    marker.kind === "ordered" ? `${marker.numberText}${marker.delimiter}` : marker.bullet;
  const space = marker.space.length;
  return markerText.length + (space >= 1 && space <= 4 ? space : 1);
}

/** The nearest item above at a shallower indent: the one `indent` nests under. */
function parentMarker(value: string, line: Line, indent: string): ListMarker | null {
  if (indent === "") return null;
  for (const marker of listLinesAbove(value, line)) {
    if (isDeeper(indent, marker.indent)) return marker;
  }
  return null;
}

/**
 * Enter on a list item line: continue the list, or, on an empty item, leave
 * one level of nesting or the list itself. Returns null for non-list lines,
 * carets inside the marker, and carets inside an inline chip — all fall
 * through to a plain newline.
 */
export function listContinuationForEnter(value: string, cursor: number): ComposerListEdit | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > value.length) return null;
  const line = currentLine(value, cursor);
  const parsed = parseListMarker(line.text);
  if (!parsed) return null;
  const markerEnd = line.start + parsed.markerEnd;
  if (cursor < markerEnd) return null;
  if (isInsideInlineToken(value, cursor)) return null;
  if (value.slice(markerEnd, line.end).trim() === "") {
    // Empty item: a nested one moves up a level and continues its parent's
    // list; a top-level one exits the list by removing the marker.
    const parent = parentMarker(value, line, parsed.marker.indent);
    return {
      start: line.start,
      end: Math.max(cursor, markerEnd),
      replacement: parent ? nextMarkerText(parent) : "",
    };
  }
  return {
    start: cursor,
    end: cursor,
    replacement: `\n${nextMarkerText(parsed.marker)}`,
  };
}

interface ListPrefix {
  indent: string;
  numberText?: string;
}

/** The list item line at a collapsed caret, unless the caret splits an inline chip. */
function listLineAt(
  value: string,
  start: number,
  end: number,
): { line: Line; marker: ListMarker } | null {
  if (!Number.isInteger(start) || start !== end || start < 0 || start > value.length) return null;
  const line = currentLine(value, start);
  const parsed = parseListMarker(line.text);
  if (!parsed || isInsideInlineToken(value, start)) return null;
  return { line, marker: parsed.marker };
}

/** Rewrites the item's indent and, for ordered items, its number, keeping the caret on the text. */
function rewritePrefix(
  line: Line,
  marker: ListMarker,
  prefix: ListPrefix,
  cursor: number,
): ComposerListEdit {
  const editEnd =
    line.start + marker.indent.length + (marker.kind === "ordered" ? marker.numberText.length : 0);
  const replacement = `${prefix.indent}${marker.kind === "ordered" ? (prefix.numberText ?? "1") : ""}`;
  const shift = replacement.length - (editEnd - line.start);
  return {
    start: line.start,
    end: editEnd,
    replacement,
    cursor: cursor >= editEnd ? cursor + shift : line.start + replacement.length,
  };
}

/**
 * Tab on a list item line: nest it under the item above at the same indent,
 * written at that item's content column. A nested ordered item continues the
 * numbering of the sublist it joins, or starts it at 1. With no item to nest
 * under it indents by two spaces. Ranged selections, non-list lines, and
 * carets inside an inline chip fall through (Shift+Tab stays the plan-mode
 * toggle and is handled before this is consulted).
 */
export function listIndentForTab(
  value: string,
  start: number,
  end: number,
): ComposerListEdit | null {
  const at = listLineAt(value, start, end);
  if (!at) return null;
  const nested = nestedPrefix(value, at.line, at.marker);
  if (!nested) {
    return { start: at.line.start, end: at.line.start, replacement: "  ", cursor: start + 2 };
  }
  return rewritePrefix(at.line, at.marker, nested, start);
}

function nestedPrefix(value: string, line: Line, marker: ListMarker): ListPrefix | null {
  // Items already nested under the new parent, nearest first.
  const children: ListMarker[] = [];
  for (const above of listLinesAbove(value, line)) {
    if (isDeeper(above.indent, marker.indent)) {
      children.push(above);
      continue;
    }
    if (above.indent !== marker.indent) return null;
    // Join the sublist the item above already has, or start one at its content column.
    const sublistDepth = Math.min(...children.map((child) => child.indent.length));
    const lastChild = children.find((child) => child.indent.length === sublistDepth);
    const indent = lastChild?.indent ?? `${marker.indent}${" ".repeat(childIndentWidth(above))}`;
    if (marker.kind !== "ordered") return { indent };
    const sibling =
      lastChild?.kind === "ordered" && lastChild.delimiter === marker.delimiter ? lastChild : null;
    const numberText = sibling
      ? nextOrderedMarkerText(`${sibling.numberText}${sibling.delimiter}`).slice(0, -1)
      : "1";
    return { indent, numberText };
  }
  return null;
}
