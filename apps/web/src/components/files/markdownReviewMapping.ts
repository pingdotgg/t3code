import { sha256 } from "@noble/hashes/sha2";
import type { ReviewCommentContext } from "~/reviewCommentContext";

/** Fingerprint exact source text so annotations can detect changes without retaining another document copy. */
export function markdownSourceRevision(contents: string): string {
  return [...sha256(new TextEncoder().encode(contents))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
/** Return updates only for current notes whose captured file revision no longer matches. */
export function staleMarkdownNotes(
  comments: readonly ReviewCommentContext[],
  path: string,
  contents: string,
): ReviewCommentContext[] {
  const revision = markdownSourceRevision(contents);
  return comments.flatMap((comment) =>
    comment.filePath === path &&
    comment.sourceRevision &&
    comment.sourceRevision !== revision &&
    !comment.sourceStale
      ? [
          {
            ...comment,
            sourceStale: true,
            rangeLabel: `Outdated · ${comment.rangeLabel}`,
            sectionTitle: "Outdated file comment",
          },
        ]
      : [],
  );
}
/** Runs after sanitization: authored HTML cannot forge a source marker. */
export function rehypeMarkdownSourceLines() {
  return (tree: { children?: unknown[] }) => {
    /** Annotate sanitized elements using parser-owned source positions, never authored marker attributes. */
    function visit(value: unknown) {
      if (!value || typeof value !== "object") return;
      const node = value as {
        type?: string;
        properties?: Record<string, unknown>;
        position?: { start: { line: number }; end: { line: number } };
        children?: unknown[];
      };
      if (node.type === "element" && node.position)
        node.properties = {
          ...node.properties,
          "data-t3-source-start": node.position.start.line,
          "data-t3-source-end": node.position.end.line,
        };
      node.children?.forEach(visit);
    }
    visit(tree);
  };
}
/** Resolve a rendered selection through trusted source markers, rejecting ranges outside the document. */
export function renderedMarkdownSelection(
  root: HTMLElement,
): { startLine: number; endLine: number } | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  /** Find a source marker on an element or the enclosing element of a selected text node. */
  function marker(node: Node) {
    return (
      (node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement
      )?.closest<HTMLElement>("[data-t3-source-start]") ?? null
    );
  }
  const first = marker(range.startContainer);
  const last = marker(range.endContainer);
  if (!first || !last || !root.contains(first) || !root.contains(last)) return null;
  const startLine = Number(first.dataset.t3SourceStart);
  const endLine = Number(last.dataset.t3SourceEnd);
  return Number.isSafeInteger(startLine) &&
    Number.isSafeInteger(endLine) &&
    startLine > 0 &&
    endLine >= startLine
    ? { startLine, endLine }
    : null;
}
