interface MarkdownPosition {
  readonly start?: {
    readonly line?: number;
    readonly offset?: number;
  };
}

interface MarkdownAstNode {
  readonly type: string;
  readonly value?: unknown;
  readonly position?: MarkdownPosition;
  children?: MarkdownAstNode[];
}

interface MarkdownFile {
  readonly value?: unknown;
}

interface MarkdownParser {
  parse(markdown: string): unknown;
}

const INLINE_PARSE_PREFIX = "t3-markdown-inline-prefix:";

function isSameLineOverIndentedCode(
  node: MarkdownAstNode,
  parent: MarkdownAstNode | undefined,
  markdown: string,
): boolean {
  if (
    node.type !== "code" ||
    parent?.type !== "listItem" ||
    typeof node.value !== "string" ||
    !/^[\t ]/.test(node.value)
  ) {
    return false;
  }

  const nodeStart = node.position?.start;
  const parentStart = parent.position?.start;
  if (
    nodeStart?.line === undefined ||
    nodeStart.offset === undefined ||
    parentStart?.line === undefined ||
    nodeStart.line !== parentStart.line
  ) {
    return false;
  }

  const sourceCharacter = markdown[nodeStart.offset];
  return sourceCharacter !== "`" && sourceCharacter !== "~";
}

function parseInlineMarkdown(value: string, parser: MarkdownParser): MarkdownAstNode[] {
  // A text prefix forces block-looking input into a paragraph while preserving
  // the processor's configured inline extensions (for example, GFM syntax).
  const document = parser.parse(`${INLINE_PARSE_PREFIX}${value}`) as MarkdownAstNode;
  const paragraph = document.children?.[0];
  const children = paragraph?.type === "paragraph" ? paragraph.children : undefined;
  const first = children?.[0];
  if (
    !children ||
    first?.type !== "text" ||
    typeof first.value !== "string" ||
    !first.value.startsWith(INLINE_PARSE_PREFIX)
  ) {
    return [{ type: "text", value }];
  }

  const firstValue = first.value.slice(INLINE_PARSE_PREFIX.length);
  return [...(firstValue ? [{ ...first, value: firstValue }] : []), ...children.slice(1)];
}

function paragraphFromIndentedCode(node: MarkdownAstNode, parser: MarkdownParser): MarkdownAstNode {
  const value = typeof node.value === "string" ? node.value.trim() : "";
  return {
    type: "paragraph",
    children: parseInlineMarkdown(value, parser),
    ...(node.position ? { position: node.position } : {}),
  };
}

/**
 * CommonMark treats four or more spaces after a list marker as an indented
 * code block. In chat output, excessive spacing is commonly accidental
 * alignment such as `-       text`, which otherwise produces a full code card
 * for every bullet. Only normalize blocks that retain excess indentation and
 * start on the marker's own line; explicit fences and conventional indented
 * blocks remain code.
 */
function attachListItemIndentationNormalizer(this: MarkdownParser) {
  return (tree: MarkdownAstNode, file: MarkdownFile) => {
    if (typeof file.value !== "string") {
      return;
    }
    const markdown = file.value;

    const visit = (node: MarkdownAstNode) => {
      if (!node.children) {
        return;
      }
      node.children = node.children.map((child) => {
        if (isSameLineOverIndentedCode(child, node, markdown)) {
          return paragraphFromIndentedCode(child, this);
        }
        visit(child);
        return child;
      });
    };

    visit(tree);
  };
}

export const remarkNormalizeListItemIndentation = attachListItemIndentationNormalizer;
