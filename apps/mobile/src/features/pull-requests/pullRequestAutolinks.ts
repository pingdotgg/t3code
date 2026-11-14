import type { ReferenceAutolink } from "@t3tools/client-runtime/source-control-clients";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

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
const HTML_TAG = /<!--[\s\S]*?(?:-->|$)|<\/?[a-z](?:[^"'<>]|"[^"]*"|'[^']*')*>/giu;
const PROTECTED_TAG = /^<(\/)?(?:a|code|pre|script|style)(?=[\s>])/iu;

/**
 * Rewrites the references `autolinks` finds in the markdown's prose as markdown links, because the
 * native renderer takes markdown text. Text is searched as written, escapes included.
 */
export function linkReferenceAutolinks(
  markdown: string,
  autolinks: ((text: string) => ReadonlyArray<ReferenceAutolink>) | null,
): string {
  if (autolinks === null) return markdown;
  const edits: { start: number; end: number; value: string }[] = [];
  // `base` is where the parsed source starts in `markdown`.
  const visit = (node: MarkdownNode, base: number) => {
    if (UNLINKED_TYPES.has(node.type)) return;
    if (node.type === "text") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      for (const link of autolinks(markdown.slice(base + start, base + end))) {
        edits.push({
          start: base + start + link.index,
          end: base + start + link.index + link.text.length,
          value: `[${link.label}](${link.url})`,
        });
      }
    } else if (node.children !== undefined) {
      let protectedHtmlDepth = 0;
      for (const child of node.children) {
        if (child.type !== "html") {
          if (protectedHtmlDepth === 0) visit(child, base);
          continue;
        }
        const start = child.position?.start.offset;
        const end = child.position?.end.offset;
        if (start === undefined || end === undefined) continue;
        // The native renderer shows text between an HTML block's tags as markdown, so link its prose.
        let from = base + start;
        const linkHtmlText = (to: number) => {
          if (protectedHtmlDepth === 0 && from < to) {
            visit(parser.parse(markdown.slice(from, to)), from);
          }
        };
        for (const tag of markdown.slice(base + start, base + end).matchAll(HTML_TAG)) {
          linkHtmlText(base + start + tag.index);
          const protectedTag = PROTECTED_TAG.exec(tag[0]);
          if (protectedTag) {
            protectedHtmlDepth = Math.max(0, protectedHtmlDepth + (protectedTag[1] ? -1 : 1));
          }
          from = base + start + tag.index + tag[0].length;
        }
        linkHtmlText(base + end);
      }
    }
  };
  visit(parser.parse(markdown), 0);
  let linked = markdown;
  for (let index = edits.length - 1; index >= 0; index--) {
    const edit = edits[index]!;
    linked = linked.slice(0, edit.start) + edit.value + linked.slice(edit.end);
  }
  return linked;
}
