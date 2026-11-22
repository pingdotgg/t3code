import type { Root, RootContent } from "mdast";
import type { Plugin } from "unified";
import { spacedFilePathDestinationEnd } from "./markdownLinks.ts";

const SPACED_FILE_LINK_TRIGGER = /\]\([ \t]*(?:\/(?![/\\])|~[\\/]|[A-Za-z]:[\\/])/;

function isEscaped(source: string, offset: number): boolean {
  let start = offset;
  while (source[start - 1] === "\\") start -= 1;
  return (offset - start) % 2 !== 0;
}

/**
 * Finds the end offset (exclusive) of a CommonMark inline code span starting at `openStart`
 * (where `source[openStart] === "`"), or -1 when no matching closing backtick run exists before
 * the next blank line.
 */
function inlineCodeSpanEnd(source: string, openStart: number): number {
  let runEnd = openStart;
  while (source[runEnd] === "`") runEnd += 1;
  const tickCount = runEnd - openStart;
  let index = runEnd;
  while (index < source.length) {
    const ch = source[index]!;
    if (ch === "\n") {
      let next = index + 1;
      while (source[next] === " " || source[next] === "\t" || source[next] === "\r") next += 1;
      if (source[next] === "\n") return -1;
      index += 1;
      continue;
    }
    if (ch === "`") {
      let closeEnd = index;
      while (source[closeEnd] === "`") closeEnd += 1;
      if (closeEnd - index === tickCount) return closeEnd;
      index = closeEnd;
      continue;
    }
    index += 1;
  }
  return -1;
}

interface SpacedFilePathCandidate {
  readonly opener: number;
  readonly start: number;
  readonly end: number;
}

function* spacedFilePathCandidates(source: string): Generator<SpacedFilePathCandidate> {
  if (!SPACED_FILE_LINK_TRIGGER.test(source)) return;
  const openBrackets: number[] = [];
  const token = /[[\]\\`]|\n[ \t\r]*\n/g;
  for (let match = token.exec(source); match; match = token.exec(source)) {
    const ch = match[0];
    if (ch === "\\") {
      token.lastIndex = match.index + 2;
      continue;
    }
    if (ch === "`") {
      const codeEnd = inlineCodeSpanEnd(source, match.index);
      if (codeEnd > 0) {
        token.lastIndex = codeEnd;
      } else {
        let runEnd = match.index + 1;
        while (source[runEnd] === "`") runEnd += 1;
        token.lastIndex = runEnd;
      }
      continue;
    }
    if (ch.startsWith("\n")) {
      openBrackets.length = 0;
      continue;
    }
    if (ch === "[") {
      openBrackets.push(match.index);
      continue;
    }
    const bracketStart = openBrackets.pop();
    if (bracketStart === undefined || source[match.index + 1] !== "(") continue;
    let start = match.index + 2;
    while (source[start] === " " || source[start] === "\t") start += 1;
    const destination = spacedFilePathDestinationEnd(source, start);
    if (!destination) continue;
    const isImage =
      bracketStart > 0 && source[bracketStart - 1] === "!" && !isEscaped(source, bracketStart - 1);
    const opener = isImage ? bracketStart - 1 : bracketStart;
    yield { opener, start, end: destination.hrefEnd };
    openBrackets.length = 0;
    token.lastIndex = destination.end;
  }
}

export interface WrappedSpacedFilePaths {
  readonly markdown: string;
  readonly insertions: readonly number[];
}

export function hasSpacedFilePathCandidate(source: string): boolean {
  return SPACED_FILE_LINK_TRIGGER.test(source);
}

/**
 * Wraps bare local file/media destinations containing spaces in `<...>`, skipping any candidate
 * whose opener or destination overlaps a protected range (such as code blocks, HTML comments, or
 * already-parsed links/images).
 */
export function wrapSpacedFilePathsInProtectedRanges(
  source: string,
  protectedRanges: ReadonlyArray<readonly [number, number]>,
  allowedOpenerRanges?: ReadonlyArray<readonly [number, number]>,
): WrappedSpacedFilePaths | undefined {
  const candidates = [...spacedFilePathCandidates(source)];
  if (candidates.length === 0) return undefined;

  const parts: string[] = [];
  const insertions: number[] = [];
  let writtenTo = 0;
  for (const { opener, start, end } of candidates) {
    if (
      opener < writtenTo ||
      (allowedOpenerRanges !== undefined &&
        !allowedOpenerRanges.some(([from, to]) => opener >= from && opener < to)) ||
      protectedRanges.some(([from, to]) => from < end && to > opener)
    ) {
      continue;
    }
    parts.push(source.slice(writtenTo, start), "<", source.slice(start, end), ">");
    insertions.push(start + insertions.length, end + insertions.length + 1);
    writtenTo = end;
  }
  if (insertions.length === 0) return undefined;
  parts.push(source.slice(writtenTo));
  return { markdown: parts.join(""), insertions };
}

function wrapSpacedFilePaths(source: string, readTree: () => Root) {
  if (!hasSpacedFilePathCandidate(source)) return undefined;

  const textRanges: Array<[number, number]> = [];
  const literalRanges: Array<[number, number]> = [];
  const visit = (node: Root | RootContent) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if ("children" in node) {
      if (node.type === "link" && end !== undefined) {
        const labelEnd = node.children.at(-1)?.position?.end.offset;
        if (labelEnd !== undefined && labelEnd < end) {
          literalRanges.push([labelEnd, end]);
        }
      }
      node.children.forEach(visit);
    } else if (start !== undefined && end !== undefined) {
      (node.type === "text" ? textRanges : literalRanges).push([start, end]);
    }
  };
  visit(readTree());

  return wrapSpacedFilePathsInProtectedRanges(source, literalRanges, textRanges);
}

export function markdownWithSpacedFilePaths(source: string, readTree: () => Root): string {
  return wrapSpacedFilePaths(source, readTree)?.markdown ?? source;
}

export function countSpacedFilePathInsertionsBefore(
  insertions: readonly number[],
  offset: number,
): number {
  let low = 0;
  let high = insertions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (insertions[middle]! < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Reparse only when a bare local file/media path needs angle brackets, keeping authored positions. */
export const remarkSpacedFilePaths: Plugin<[], Root> = function () {
  const parse = this.parser;
  if (!parse) return;
  this.parser = (source, file) => {
    const tree = parse(source, file) as Root;
    const repaired = wrapSpacedFilePaths(source, () => tree);
    if (!repaired) return tree;
    const { markdown, insertions } = repaired;
    const parsed = parse(markdown, file) as Root;
    const moved = new Set<object>();
    const restorePositions = (node: Root | RootContent) => {
      if (node.position) {
        for (const point of [node.position.start, node.position.end]) {
          if (point.offset === undefined || moved.has(point)) continue;
          moved.add(point);
          const before = countSpacedFilePathInsertionsBefore(insertions, point.offset);
          const beforeLine = countSpacedFilePathInsertionsBefore(
            insertions,
            point.offset - point.column + 1,
          );
          point.offset -= before;
          point.column -= before - beforeLine;
        }
      }
      if ("children" in node) node.children.forEach(restorePositions);
    };
    restorePositions(parsed);
    return parsed;
  };
};
