import type { Root, RootContent } from "mdast";
import type { Plugin } from "unified";
import { spacedFilePathDestinationEnd } from "./markdownLinks.ts";

const SPACED_FILE_LINK_TRIGGER = /\]\([ \t]*(?:\/(?![/\\])|~[\\/]|[A-Za-z]:[\\/])/;

type OffsetRange = readonly [number, number];

function isEscaped(source: string, offset: number): boolean {
  let start = offset;
  while (source[start - 1] === "\\") start -= 1;
  return (offset - start) % 2 !== 0;
}

function mergeRanges(ranges: ReadonlyArray<OffsetRange>): OffsetRange[] {
  if (ranges.length <= 1) return ranges.filter(([from, to]) => from < to);
  const sorted = ranges
    .filter(([from, to]) => from < to)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: OffsetRange[] = [];
  for (const [from, to] of sorted) {
    const previous = merged.at(-1);
    if (previous && from <= previous[1]) {
      merged[merged.length - 1] = [previous[0], Math.max(previous[1], to)];
    } else {
      merged.push([from, to]);
    }
  }
  return merged;
}

/** Returns the index of the first merged range with `to > offset`, or `ranges.length`. */
function firstRangeEndingAfter(ranges: ReadonlyArray<OffsetRange>, offset: number): number {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle]![1] <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function overlapsMergedRanges(
  ranges: ReadonlyArray<OffsetRange>,
  start: number,
  end: number,
): boolean {
  const index = firstRangeEndingAfter(ranges, start);
  return index < ranges.length && ranges[index]![0] < end;
}

function containsMergedOffset(ranges: ReadonlyArray<OffsetRange>, offset: number): boolean {
  const index = firstRangeEndingAfter(ranges, offset);
  return index < ranges.length && ranges[index]![0] <= offset;
}

function findNextBlankLine(source: string, from: number, limit: number): number {
  for (let index = from; index < limit; index += 1) {
    if (source[index] !== "\n") continue;
    let next = index + 1;
    while (
      next < limit &&
      (source[next] === " " || source[next] === "\t" || source[next] === "\r")
    ) {
      next += 1;
    }
    if (next < limit && source[next] === "\n") return index;
  }
  return limit;
}

/**
 * Indexes backtick runs per contiguous non-protected paragraph in linear time so unmatched
 * backtick runs never rescan the remaining paragraph.
 */
function createInlineCodeSpanFinder(source: string, protectedRanges: ReadonlyArray<OffsetRange>) {
  let segmentEnd = -1;
  let runsByLength = new Map<number, number[]>();

  const indexSegment = (from: number) => {
    const nextProtectedIndex = firstRangeEndingAfter(protectedRanges, from);
    const nextProtectedStart =
      nextProtectedIndex < protectedRanges.length
        ? protectedRanges[nextProtectedIndex]![0]
        : source.length;
    segmentEnd = findNextBlankLine(source, from, Math.min(source.length, nextProtectedStart));
    runsByLength = new Map();
    for (let index = from; index < segmentEnd;) {
      if (source[index] !== "`") {
        index += 1;
        continue;
      }
      let runEnd = index + 1;
      while (runEnd < segmentEnd && source[runEnd] === "`") runEnd += 1;
      const length = runEnd - index;
      let list = runsByLength.get(length);
      if (!list) {
        list = [];
        runsByLength.set(length, list);
      }
      list.push(index);
      index = runEnd;
    }
  };

  return (openStart: number): number => {
    if (openStart >= segmentEnd) indexSegment(openStart);
    let runEnd = openStart + 1;
    while (runEnd < segmentEnd && source[runEnd] === "`") runEnd += 1;
    const tickCount = runEnd - openStart;
    const starts = runsByLength.get(tickCount);
    if (!starts || starts.length < 2) return -1;
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (starts[middle]! <= openStart) low = middle + 1;
      else high = middle;
    }
    return low < starts.length ? starts[low]! + tickCount : -1;
  };
}

interface SpacedFilePathCandidate {
  readonly isImage: boolean;
  readonly opener: number;
  readonly start: number;
  readonly end: number;
}

function* spacedFilePathCandidates(
  source: string,
  protectedRanges: ReadonlyArray<OffsetRange>,
): Generator<SpacedFilePathCandidate> {
  if (!SPACED_FILE_LINK_TRIGGER.test(source)) return;
  const inlineCodeSpanEnd = createInlineCodeSpanFinder(source, protectedRanges);
  const openBrackets: number[] = [];
  const token = /[[\]\\`]|\n[ \t\r]*\n/g;
  for (let match = token.exec(source); match; match = token.exec(source)) {
    const protectedIndex = firstRangeEndingAfter(protectedRanges, match.index);
    if (
      protectedIndex < protectedRanges.length &&
      protectedRanges[protectedIndex]![0] <= match.index
    ) {
      openBrackets.length = 0;
      token.lastIndex = protectedRanges[protectedIndex]![1];
      continue;
    }
    const ch = match[0];
    if (ch === "\\") {
      token.lastIndex = match.index + 2;
      continue;
    }
    if (ch === "`") {
      const codeEnd = inlineCodeSpanEnd(match.index);
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
    yield { isImage, opener, start, end: destination.hrefEnd };
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
  protectedRanges: ReadonlyArray<OffsetRange>,
  allowedOpenerRanges?: ReadonlyArray<OffsetRange>,
  protectedLinkRanges?: ReadonlyArray<OffsetRange>,
  inlineProtectedRanges?: ReadonlyArray<OffsetRange>,
): WrappedSpacedFilePaths | undefined {
  const mergedProtected = mergeRanges(protectedRanges);
  const mergedInlineProtected = inlineProtectedRanges
    ? mergeRanges(inlineProtectedRanges)
    : undefined;
  const mergedAllowed = allowedOpenerRanges ? mergeRanges(allowedOpenerRanges) : undefined;
  const mergedProtectedLinks = protectedLinkRanges ? mergeRanges(protectedLinkRanges) : undefined;
  const candidates = [...spacedFilePathCandidates(source, mergedProtected)];
  if (candidates.length === 0) return undefined;

  const parts: string[] = [];
  const insertions: number[] = [];
  let writtenTo = 0;
  for (const { isImage, opener, start, end } of candidates) {
    if (
      opener < writtenTo ||
      (mergedAllowed !== undefined && !containsMergedOffset(mergedAllowed, opener)) ||
      containsMergedOffset(mergedProtected, opener) ||
      overlapsMergedRanges(mergedProtected, start, end) ||
      (mergedInlineProtected !== undefined &&
        (containsMergedOffset(mergedInlineProtected, opener) ||
          overlapsMergedRanges(mergedInlineProtected, start, end))) ||
      (!isImage &&
        mergedProtectedLinks !== undefined &&
        overlapsMergedRanges(mergedProtectedLinks, opener, end))
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

  const textRanges: OffsetRange[] = [];
  const literalRanges: OffsetRange[] = [];
  const inlineCodeRanges: OffsetRange[] = [];
  const linkRanges: OffsetRange[] = [];
  const visit = (node: Root | RootContent) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if ("children" in node) {
      if (
        (node.type === "link" || node.type === "linkReference") &&
        start !== undefined &&
        end !== undefined
      ) {
        linkRanges.push([start, end]);
        const labelEnd = node.children.at(-1)?.position?.end.offset;
        if (labelEnd !== undefined && labelEnd < end) {
          literalRanges.push([labelEnd, end]);
        }
      }
      node.children.forEach(visit);
    } else if (start !== undefined && end !== undefined) {
      if (node.type === "text") textRanges.push([start, end]);
      else if (node.type === "inlineCode") inlineCodeRanges.push([start, end]);
      else literalRanges.push([start, end]);
    }
  };
  visit(readTree());

  return wrapSpacedFilePathsInProtectedRanges(
    source,
    literalRanges,
    textRanges,
    linkRanges,
    inlineCodeRanges,
  );
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
