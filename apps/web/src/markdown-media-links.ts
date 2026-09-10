import {
  classifyMarkdownImageSource,
  markdownLinkMediaKind,
} from "@t3tools/client-runtime/markdown-images";

interface MarkdownAstNode {
  type: string;
  url?: string;
  title?: string | null;
  alt?: string | null;
  value?: unknown;
  children?: MarkdownAstNode[];
}

const TRAILING_NEWLINE_PATTERN = /\n[ \t]*$/u;
const LEADING_NEWLINE_PATTERN = /^[ \t]*\n/u;

function plainText(node: MarkdownAstNode): string {
  if (node.type === "image" && typeof node.alt === "string") return node.alt;
  if (typeof node.value === "string") return node.value;
  return node.children?.map(plainText).join("") ?? "";
}

/** A paragraph edge, a hard break, or a text sibling that ends (or starts) with a newline. */
function isLineBoundary(node: MarkdownAstNode | undefined, edge: "before" | "after"): boolean {
  if (node === undefined || node.type === "break") return true;
  if (node.type !== "text" || typeof node.value !== "string") return false;
  return (edge === "before" ? TRAILING_NEWLINE_PATTERN : LEADING_NEWLINE_PATTERN).test(node.value);
}

/**
 * A link that owns its line in a top-level paragraph and points at an image or video file
 * becomes an image node, so the renderer embeds the media instead of a file chip. Links
 * mixed into a sentence, list items, and quotes stay links. The soft breaks around an
 * embedded link become hard breaks so the media keeps the line to itself. Runs after the
 * Codex directives so a cited file is already a link, and after hard breaks so they count
 * as line edges.
 *
 * A path or `file:` target only loads through a thread's asset URL, so surfaces without one
 * pass `embedLocalPaths: false` and keep the chip, which can still open the file. The
 * target is classified against the same root the image renderer uses, so a link the
 * renderer could not load, such as a tilde path, also keeps its chip.
 */
export function remarkStandaloneMediaLinks(options: {
  readonly embedLocalPaths: boolean;
  readonly workspaceRoot?: string | null | undefined;
}) {
  const embeddable = (url: string) => {
    if (markdownLinkMediaKind(url) === null) return false;
    const source = classifyMarkdownImageSource(url, options.workspaceRoot);
    return source._tag === "Direct" || (options.embedLocalPaths && source._tag === "WorkspaceFile");
  };
  return (tree: MarkdownAstNode) => {
    for (const block of tree.children ?? []) {
      if (block.type !== "paragraph" || !block.children) continue;
      const siblings = block.children;
      const next: MarkdownAstNode[] = [];
      siblings.forEach((child, index) => {
        // A text sibling that an earlier embed emptied would hide the line edge from the
        // next link, so it is dropped rather than carried along.
        if (child.type === "text" && child.value === "") return;
        const before = next.at(-1);
        const after = siblings[index + 1];
        if (
          child.type !== "link" ||
          typeof child.url !== "string" ||
          !embeddable(child.url) ||
          !isLineBoundary(before, "before") ||
          !isLineBoundary(after, "after")
        ) {
          next.push(child);
          return;
        }
        if (before?.type === "text" && typeof before.value === "string") {
          before.value = before.value.replace(TRAILING_NEWLINE_PATTERN, "");
          next.push({ type: "break" });
        }
        const text = plainText(child);
        next.push({
          type: "image",
          url: child.url,
          title: child.title ?? null,
          // An autolink's text is its URL, which is not worth repeating as alt text.
          alt: text === child.url ? "" : text,
        });
        if (after?.type === "text" && typeof after.value === "string") {
          after.value = after.value.replace(LEADING_NEWLINE_PATTERN, "");
          next.push({ type: "break" });
        }
      });
      block.children = next;
    }
  };
}
