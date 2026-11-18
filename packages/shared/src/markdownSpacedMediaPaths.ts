import type { Root, RootContent } from "mdast";
import type { Plugin } from "unified";
import { mediaKindFromPath } from "./mediaPreview.ts";

// Bare POSIX media paths can contain spaces and balanced parenthesized folder names.
const MEDIA_EMBED =
  /!\[(?:\\[^\r\n]|[^[\]\\\r\n])*\]\((\/(?![/\\])(?:\\[^\r\n]|[^\\<>[\]`\r\n()]|\([^\\<>[\]`\r\n()]*\))+)\)/g;

function isEscaped(source: string, offset: number): boolean {
  let start = offset;
  while (source[start - 1] === "\\") start--;
  return (offset - start) % 2 !== 0;
}

function* spacedMediaPaths(source: string) {
  if (!source.includes("](/")) return;
  for (const match of source.matchAll(MEDIA_EMBED)) {
    const path = match[1]!;
    if (!/[ \t]/.test(path) || !mediaKindFromPath(path) || isEscaped(source, match.index)) {
      continue;
    }
    const end = match.index + match[0].length - 1;
    yield { opener: match.index, start: end - path.length, end };
  }
}

function wrapSpacedMediaPaths(source: string, readTree: () => Root) {
  const candidates = spacedMediaPaths(source);
  let candidate = candidates.next().value;
  if (!candidate) return undefined;

  const parts: string[] = [];
  const insertions: number[] = [];
  let writtenTo = 0;
  const visit = (node: Root | RootContent) => {
    if (!candidate) return;
    if (node.type === "text") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      // Only repair openers the parser left as text. This skips valid images, code and HTML.
      while (candidate && candidate.opener < end) {
        if (candidate.opener >= start && candidate.opener >= writtenTo) {
          const { start, end } = candidate;
          parts.push(source.slice(writtenTo, start), "<", source.slice(start, end), ">");
          insertions.push(start + insertions.length, end + insertions.length + 1);
          writtenTo = end;
        }
        candidate = candidates.next().value;
      }
    } else if ("children" in node) {
      node.children.forEach(visit);
    }
  };
  visit(readTree());
  if (insertions.length === 0) return undefined;
  parts.push(source.slice(writtenTo));
  return { markdown: parts.join(""), insertions };
}

export function markdownWithSpacedMediaPaths(source: string, readTree: () => Root): string {
  return wrapSpacedMediaPaths(source, readTree)?.markdown ?? source;
}

function countInsertionsBefore(insertions: number[], offset: number): number {
  let low = 0;
  let high = insertions.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (insertions[middle]! < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Reparse only when a bare local media path needs brackets, keeping authored source positions. */
export const remarkSpacedMediaPaths: Plugin<[], Root> = function () {
  const parse = this.parser;
  if (!parse) return;
  this.parser = (source, file) => {
    const tree = parse(source, file) as Root;
    const repaired = wrapSpacedMediaPaths(source, () => tree);
    if (!repaired) return tree;
    const { markdown, insertions } = repaired;
    const parsed = parse(markdown, file) as Root;
    const restorePositions = (node: Root | RootContent) => {
      if (node.position) {
        for (const point of [node.position.start, node.position.end]) {
          if (point.offset === undefined) continue;
          const before = countInsertionsBefore(insertions, point.offset);
          const beforeLine = countInsertionsBefore(insertions, point.offset - point.column + 1);
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
