/**
 * Rendered markdown keeps no trace of the file it came from, so a selection in
 * the preview cannot name the lines it covers. `remarkStampSourceLines` records
 * the source line span of every block on its rendered element, and
 * `resolveSelectionSourceLines` reads that span back off a DOM selection.
 *
 * ChatMarkdown runs the plugin only for callers that pass it through
 * `extraRemarkPlugins`, so chat messages keep the markup they render today.
 */

interface SourceLinePosition {
  readonly line?: number;
}

interface SourceLineAstNode {
  readonly type: string;
  readonly position?: {
    readonly start?: SourceLinePosition;
    readonly end?: SourceLinePosition;
  };
  data?: {
    hProperties?: Record<string, unknown>;
  };
  children?: SourceLineAstNode[];
}

/**
 * Blocks that reach the DOM as an element of their own. Nested types are listed
 * alongside their containers so the innermost block wins when a selection
 * starts inside a list item or a table cell.
 */
const STAMPED_NODE_TYPES = new Set([
  "blockquote",
  "code",
  "definition",
  "footnoteDefinition",
  "heading",
  "html",
  "list",
  "listItem",
  "paragraph",
  "table",
  "tableCell",
  "tableRow",
  "thematicBreak",
]);

export interface MarkdownSourceLineRange {
  readonly startLine: number;
  readonly endLine: number;
}

function spanOf(node: SourceLineAstNode): MarkdownSourceLineRange | null {
  const startLine = node.position?.start?.line;
  const endLine = node.position?.end?.line;
  return startLine === undefined || endLine === undefined ? null : { startLine, endLine };
}

export function remarkStampSourceLines() {
  return (tree: SourceLineAstNode) => {
    const visit = (node: SourceLineAstNode, enclosing: MarkdownSourceLineRange | null) => {
      // A plugin that re-parses part of the document hands back blocks whose
      // positions belong to that fragment rather than the file — see the
      // recovery in `remarkNormalizeListItemIndentation`. A span that escapes
      // the one enclosing it is one of those, and stamping it would point a
      // quote at whatever happens to live on that line.
      const span = spanOf(node);
      const trusted =
        span !== null &&
        (enclosing === null ||
          (span.startLine >= enclosing.startLine && span.endLine <= enclosing.endLine));

      if (trusted && STAMPED_NODE_TYPES.has(node.type)) {
        const data = (node.data ??= {});
        data.hProperties = {
          ...data.hProperties,
          dataMdStartLine: span.startLine,
          dataMdEndLine: span.endLine,
        };
      }

      const childEnclosing = trusted ? span : enclosing;
      node.children?.forEach((child) => visit(child, childEnclosing));
    };

    visit(tree, null);
  };
}

/** Stable identity keeps ChatMarkdown's plugin list from re-rendering the tree. */
export const MARKDOWN_SOURCE_LINE_PLUGINS = [remarkStampSourceLines];

function stampedAncestor(node: Node | null, container: HTMLElement): HTMLElement | null {
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  const stamped = element?.closest<HTMLElement>("[data-md-start-line]") ?? null;
  return stamped && container.contains(stamped) ? stamped : null;
}

function readStampedLine(element: HTMLElement | null, attribute: "mdStartLine" | "mdEndLine") {
  const value = Number(element?.dataset[attribute]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Source lines a rendered selection covers, or null when either end falls
 * outside markdown this preview stamped.
 */
export function resolveSelectionSourceLines(
  range: Range,
  container: HTMLElement,
): MarkdownSourceLineRange | null {
  const startLine = readStampedLine(
    stampedAncestor(range.startContainer, container),
    "mdStartLine",
  );
  const endLine = readStampedLine(stampedAncestor(range.endContainer, container), "mdEndLine");
  if (startLine === null || endLine === null) return null;
  return startLine <= endLine ? { startLine, endLine } : { startLine: endLine, endLine: startLine };
}
