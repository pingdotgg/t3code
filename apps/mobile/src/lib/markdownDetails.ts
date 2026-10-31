import { unified } from "unified";
import remarkParse from "remark-parse";

import { decodeHtmlEntities, markdownHtmlTags } from "./markdownDocument";

export type MarkdownDetailsSegment =
  | { readonly kind: "markdown"; readonly markdown: string; readonly sourceOffset: number }
  | {
      readonly kind: "details";
      readonly summary: string;
      readonly body: string;
      readonly open: boolean;
      readonly sourceOffset: number;
    };

const parser = unified().use(remarkParse);
const DETAILS_TAG = /^<(\/?)details\b/i;
const SUMMARY = /^\s*<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i;

/**
 * Splits top-level `<details>` blocks out of chat Markdown so they can render as folds.
 * Tags inside code or inline in a paragraph stay Markdown. A fold whose closing tag has
 * not streamed yet runs to the end.
 */
export function splitMarkdownDetails(markdown: string): ReadonlyArray<MarkdownDetailsSegment> {
  if (!/<details\b/i.test(markdown)) return [{ kind: "markdown", markdown, sourceOffset: 0 }];

  const folds: Array<{ start: number; openTagEnd: number; end: number; open: boolean }> = [];
  let depth = 0;
  let current: { start: number; openTagEnd: number; open: boolean } | null = null;
  for (const node of parser.parse(markdown).children) {
    if (node.type !== "html" || node.position?.start.offset === undefined) continue;
    const nodeStart = node.position.start.offset;
    for (const tag of markdownHtmlTags(node.value)) {
      const details = DETAILS_TAG.exec(tag[0]);
      if (!details) continue;
      const start = nodeStart + tag.index;
      if (details[1] !== "/") {
        if (depth === 0) {
          current = { start, openTagEnd: start + tag[0].length, open: /\sopen\b/i.test(tag[0]) };
        }
        depth += 1;
      } else if (depth > 0) {
        depth -= 1;
        if (depth === 0 && current) {
          folds.push({ ...current, end: start + tag[0].length });
          current = null;
        }
      }
    }
  }
  if (current) folds.push({ ...current, end: markdown.length });
  if (folds.length === 0) return [{ kind: "markdown", markdown, sourceOffset: 0 }];

  const segments: MarkdownDetailsSegment[] = [];
  let cursor = 0;
  for (const fold of folds) {
    if (fold.start > cursor) {
      segments.push({
        kind: "markdown",
        markdown: markdown.slice(cursor, fold.start),
        sourceOffset: cursor,
      });
    }
    const closed = markdown.slice(fold.start, fold.end).match(/<\/details\s*>$/i);
    let body = markdown.slice(fold.openTagEnd, fold.end - (closed?.[0].length ?? 0));
    const summary = SUMMARY.exec(body);
    if (summary) body = body.slice(summary[0].length);
    const label = summary ? decodeHtmlEntities(summary[1]!.replace(/<[^>]*>/g, "")).trim() : "";
    segments.push({
      kind: "details",
      summary: label || "Details",
      body,
      open: fold.open,
      sourceOffset: fold.start,
    });
    cursor = fold.end;
  }
  if (cursor < markdown.length) {
    segments.push({ kind: "markdown", markdown: markdown.slice(cursor), sourceOffset: cursor });
  }
  return segments;
}
