import type { RootContent } from "mdast";
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

type OpenFold = { start: number; openTagEnd: number; open: boolean };

const parser = unified().use(remarkParse);
const DETAILS_TAG = /^<(\/?)details\b/i;
const SUMMARY = /^\s*<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i;

/**
 * Splits top-level `<details>` blocks out of chat Markdown so they can render as folds.
 * Tags inside code, or a fold opened inline in a paragraph, stay Markdown. A fold whose
 * closing tag has not streamed yet runs to the end.
 */
export function splitMarkdownDetails(markdown: string): ReadonlyArray<MarkdownDetailsSegment> {
  if (!/<details\b/i.test(markdown)) return [{ kind: "markdown", markdown, sourceOffset: 0 }];

  const folds: Array<OpenFold & { end: number; closeTagLength: number }> = [];
  let depth = 0;
  // Asserted so the scan closure's writes are not narrowed away after the loop.
  let current = null as OpenFold | null;
  // A fold opens only at block level; once open, a tag inside a paragraph can close it.
  const scan = (node: RootContent, inline: boolean) => {
    if (node.type !== "html") {
      if (depth > 0 && "children" in node) {
        for (const child of node.children) scan(child, true);
      }
      return;
    }
    if (node.position?.start.offset === undefined) return;
    const nodeStart = node.position.start.offset;
    for (const tag of markdownHtmlTags(node.value)) {
      const details = DETAILS_TAG.exec(tag[0]);
      if (!details || (inline && depth === 0)) continue;
      const start = nodeStart + tag.index;
      if (details[1] !== "/") {
        if (depth === 0) {
          // Quoted values are blanked so `title="is open"` does not count as the attribute.
          const attributes = tag[0].replace(/"[^"]*"|'[^']*'/g, '""');
          current = {
            start,
            openTagEnd: start + tag[0].length,
            open: /\sopen\b/i.test(attributes),
          };
        }
        depth += 1;
      } else if (depth > 0) {
        depth -= 1;
        if (depth === 0 && current) {
          folds.push({ ...current, end: start + tag[0].length, closeTagLength: tag[0].length });
          current = null;
        }
      }
    }
  };
  for (const node of parser.parse(markdown).children) scan(node, false);
  if (current) folds.push({ ...current, end: markdown.length, closeTagLength: 0 });
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
    let body = markdown.slice(fold.openTagEnd, fold.end - fold.closeTagLength);
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
