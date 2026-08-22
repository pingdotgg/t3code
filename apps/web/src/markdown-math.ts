import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

interface MarkdownNode {
  readonly type?: string;
  readonly value?: unknown;
  readonly url?: unknown;
  data?: {
    hProperties?: Record<string, unknown>;
  };
  readonly position?: {
    readonly start?: { readonly offset?: number };
    readonly end?: { readonly offset?: number };
  };
  readonly children?: readonly MarkdownNode[];
}

interface PromoteBracketDisplayMathOptions {
  readonly source: string;
}

interface HtmlNode {
  readonly type?: string;
  properties?: Record<string, unknown>;
  readonly children?: readonly HtmlNode[];
}

export const MARKDOWN_MATH_CODE_CLASS_NAMES = ["math-inline", "math-display"] as const;

const markdownParser = unified().use(remarkParse).use(remarkGfm);

type Delimiter = "(" | ")" | "[" | "]";

interface DelimiterMatch {
  readonly index: number;
  readonly delimiter: Delimiter;
}

/**
 * Converts LaTeX delimiters into the syntax understood by `remark-math`.
 *
 * CommonMark consumes the backslash in `\(` before remark plugins run. We
 * therefore inspect the original source, but use CommonMark's own text-node
 * positions to avoid rewriting code, HTML, and link destinations. Rewrites
 * are paired and length preserving so task-list source offsets remain valid.
 */
export function normalizeLatexMathDelimiters(source: string): string {
  if (!source.includes("\\(") && !source.includes("\\[")) return source;

  const replacements = new Map<number, string>();
  const tree = markdownParser.parse(source) as MarkdownNode;

  const visit = (node: MarkdownNode, linkUrl: string | null) => {
    const nextLinkUrl = node.type === "link" && typeof node.url === "string" ? node.url : linkUrl;

    if (node.type === "text") {
      // Autolink labels are their destination. Treat them as URLs rather than
      // prose even though the Markdown AST represents them as text children.
      if (!(nextLinkUrl !== null && node.value === nextLinkUrl)) {
        collectTextNodeReplacements(source, node, replacements);
      }
      return;
    }

    node.children?.forEach((child) => visit(child, nextLinkUrl));
  };

  visit(tree, null);
  if (replacements.size === 0) return source;

  const output = source.split("");
  for (const [index, replacement] of replacements) {
    output[index] = replacement[0]!;
    output[index + 1] = replacement[1]!;
  }
  return output.join("");
}

/**
 * Preserves the display semantics of same-line `\[...\]` expressions.
 *
 * `remark-math` parses their length-preserving `$$...$$` normalization as
 * inline math unless the delimiters occupy their own lines. The original
 * source has matching offsets, so it can distinguish bracket-display math
 * without inserting newlines and invalidating task-list source positions.
 */
export function remarkPromoteBracketDisplayMath(options: PromoteBracketDisplayMathOptions) {
  return (tree: MarkdownNode): void => {
    const visit = (node: MarkdownNode) => {
      if (node.type === "inlineMath") {
        const start = node.position?.start?.offset;
        const end = node.position?.end?.offset;
        if (
          start !== undefined &&
          end !== undefined &&
          options.source.slice(start, start + 2) === "\\[" &&
          options.source.slice(end - 2, end) === "\\]"
        ) {
          node.data = {
            ...node.data,
            hProperties: {
              ...node.data?.hProperties,
              className: ["language-math", "math-display"],
            },
          };
        }
      }

      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

/** Removes KaTeX's native parse-error tooltip after KaTeX generates its HTML. */
export function rehypeStripKatexErrorTitle() {
  return (tree: HtmlNode): void => {
    const visit = (node: HtmlNode) => {
      const className = node.properties?.className;
      if (
        node.type === "element" &&
        Array.isArray(className) &&
        className.includes("katex-error")
      ) {
        delete node.properties?.title;
      }
      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

function collectTextNodeReplacements(
  source: string,
  node: MarkdownNode,
  replacements: Map<number, string>,
): void {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (start === undefined || end === undefined) return;

  const delimiters: DelimiterMatch[] = [];
  for (let index = start; index < end - 1; index += 1) {
    if (source[index] !== "\\" || isEscapedBackslash(source, index)) continue;
    const delimiter = source[index + 1];
    if (delimiter === "(" || delimiter === ")" || delimiter === "[" || delimiter === "]") {
      delimiters.push({ index, delimiter });
      index += 1;
    }
  }

  let opener: DelimiterMatch | null = null;
  for (const match of delimiters) {
    if (match.delimiter === "(" || match.delimiter === "[") {
      // Math delimiters do not nest. Prefer the newest opener so malformed
      // prose cannot prevent a later valid expression from rendering.
      opener = match;
      continue;
    }
    if (opener === null) continue;

    const expectedCloser = opener.delimiter === "(" ? ")" : "]";
    if (match.delimiter !== expectedCloser) continue;

    replacements.set(opener.index, "$$");
    replacements.set(match.index, "$$");
    opener = null;
  }
}

function isEscapedBackslash(source: string, index: number): boolean {
  let precedingBackslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
    precedingBackslashes += 1;
  }
  return precedingBackslashes % 2 === 1;
}
