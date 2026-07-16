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

interface RecoveredMarkdown {
  readonly blocks: MarkdownAstNode[];
  readonly source: string;
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

function parseRecoveredMarkdown(value: string, parser: MarkdownParser): RecoveredMarkdown {
  // A text prefix forces block-looking input into a paragraph while preserving
  // the processor's configured inline extensions (for example, GFM syntax).
  // Later root children are kept as blocks so blank-line-separated content is
  // never discarded.
  const source = `${INLINE_PARSE_PREFIX}${value}`;
  const document = parser.parse(source) as MarkdownAstNode;
  const blocks = document.children;
  const paragraph = blocks?.[0];
  const children = paragraph?.type === "paragraph" ? paragraph.children : undefined;
  const first = children?.[0];
  if (
    !blocks ||
    !children ||
    first?.type !== "text" ||
    typeof first.value !== "string" ||
    !first.value.startsWith(INLINE_PARSE_PREFIX)
  ) {
    return { blocks: [{ type: "text", value }], source };
  }

  const firstValue = first.value.slice(INLINE_PARSE_PREFIX.length);
  return {
    blocks: [
      {
        ...paragraph,
        type: "paragraph",
        children: [...(firstValue ? [{ ...first, value: firstValue }] : []), ...children.slice(1)],
      },
      ...blocks.slice(1),
    ],
    source,
  };
}

function blocksFromIndentedCode(node: MarkdownAstNode, parser: MarkdownParser): RecoveredMarkdown {
  const value = typeof node.value === "string" ? node.value.trim() : "";
  const recovered = parseRecoveredMarkdown(value, parser);
  const first = recovered.blocks[0];
  return {
    ...recovered,
    blocks:
      first && node.position
        ? [{ ...first, position: node.position }, ...recovered.blocks.slice(1)]
        : recovered.blocks,
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

    const visit = (node: MarkdownAstNode, source: string) => {
      if (!node.children) {
        return;
      }
      node.children = node.children.flatMap((child) => {
        if (isSameLineOverIndentedCode(child, node, source)) {
          const recovered = blocksFromIndentedCode(child, this);
          for (const block of recovered.blocks) {
            visit(block, recovered.source);
          }
          return recovered.blocks;
        }
        visit(child, source);
        return [child];
      });
    };

    visit(tree, markdown);
  };
}

export const remarkNormalizeListItemIndentation = attachListItemIndentationNormalizer;
