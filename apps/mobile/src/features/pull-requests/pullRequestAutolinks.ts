import { githubEmojiAliases } from "@t3tools/client-runtime/pull-request-markdown";
import type { ReferenceAutolink } from "@t3tools/client-runtime/source-control-clients";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { splitLeadingBom } from "../../lib/markdownDocument";

type MarkdownNode = {
  readonly type: string;
  readonly position?:
    | {
        readonly start: { readonly offset?: number | undefined };
        readonly end: { readonly offset?: number | undefined };
      }
    | undefined;
  readonly children?: readonly MarkdownNode[] | undefined;
};

const parser = unified().use(remarkParse).use(remarkGfm);
const UNLINKED_TYPES = new Set([
  "link",
  "linkReference",
  "image",
  "imageReference",
  "code",
  "inlineCode",
  "html",
  "definition",
]);

const unchanged = (offset: number) => offset;

/**
 * Rewrites the references `autolinks` finds in the markdown's prose as markdown links, and GitHub's
 * `:alias:` emoji as the emoji, because the native renderer takes markdown text. Text is searched
 * as written, escapes included. `sourceOffset` maps an offset in the result back to `markdown`.
 */
export function nativePullRequestMarkdown(
  markdown: string,
  autolinks: ((text: string) => ReadonlyArray<ReferenceAutolink>) | null,
  githubEmoji: boolean,
): { readonly markdown: string; readonly sourceOffset: (offset: number) => number } {
  if (autolinks === null && !githubEmoji) return { markdown, sourceOffset: unchanged };
  const [bom, source] = splitLeadingBom(markdown);
  const edits: { start: number; end: number; value: string }[] = [];
  const visit = (node: MarkdownNode, inLink: boolean) => {
    // Only a bracketed label is prose; an autolink's text is its destination.
    const labelled = source[node.position?.start.offset ?? -1] === "[";
    if (node.type === "link" && labelled && !inLink) {
      node.children?.forEach((child) => visit(child, true));
      return;
    }
    if (UNLINKED_TYPES.has(node.type)) return;
    if (node.type === "text") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const text = source.slice(start, end);
      const found: { start: number; end: number; value: string }[] = [];
      for (const link of inLink ? [] : (autolinks?.(text) ?? [])) {
        found.push({
          start: start + link.index,
          end: start + link.index + link.text.length,
          value: `[${link.label}](${link.url})`,
        });
      }
      for (const alias of githubEmoji ? githubEmojiAliases(text) : []) {
        // Keycap emoji start with `*`, which the native parser would read as emphasis.
        const value = alias.emoji.replaceAll("*", "\\*");
        found.push({
          start: start + alias.index,
          end: start + alias.index + alias.text.length,
          value,
        });
      }
      found.sort((left, right) => left.start - right.start);
      for (const edit of found) {
        if (edit.start >= (edits.at(-1)?.end ?? 0)) edits.push(edit);
      }
    } else if (node.children !== undefined) {
      let protectedHtmlDepth = 0;
      for (const child of node.children) {
        if (child.type === "html") {
          const start = child.position?.start.offset;
          const end = child.position?.end.offset;
          const tag = start === undefined || end === undefined ? "" : source.slice(start, end);
          for (const match of tag.matchAll(/<(\/)?(?:a|code|pre|script|style)(?=[\s>])[^>]*>/giu)) {
            protectedHtmlDepth = Math.max(0, protectedHtmlDepth + (match[1] ? -1 : 1));
          }
        } else if (protectedHtmlDepth === 0) visit(child, inLink);
      }
    }
  };
  visit(parser.parse(markdown), false);
  if (edits.length === 0) return { markdown, sourceOffset: unchanged };
  let rewritten = bom;
  let cursor = 0;
  // Where each edit ends in the result, and how far `markdown` is ahead from there on.
  const shifts: { end: number; delta: number }[] = [];
  for (const edit of edits) {
    rewritten += source.slice(cursor, edit.start) + edit.value;
    cursor = edit.end;
    shifts.push({ end: rewritten.length, delta: bom.length + edit.end - rewritten.length });
  }
  rewritten += source.slice(cursor);
  return {
    markdown: rewritten,
    sourceOffset(offset) {
      let delta = 0;
      for (const shift of shifts) {
        if (shift.end > offset) break;
        delta = shift.delta;
      }
      return offset + delta;
    },
  };
}
