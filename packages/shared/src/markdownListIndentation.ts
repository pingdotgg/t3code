interface MarkdownPosition {
  readonly start?: { readonly line?: number; readonly column?: number; readonly offset?: number };
  readonly end?: { readonly line?: number; readonly column?: number; readonly offset?: number };
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
  readonly restorePositions?: () => void;
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
  // Prefix block-looking input to parse inline extensions; retain later block children after blank lines.
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

function blocksFromIndentedCode(
  node: MarkdownAstNode,
  parser: MarkdownParser,
  markdown: string,
): RecoveredMarkdown {
  const value = typeof node.value === "string" ? node.value.trim() : "";
  const recovered = parseRecoveredMarkdown(value, parser);
  // Reparsed children must still point into the authored file for source-aware transforms.
  const offsets = new Map<number, number>();
  let originalOffset = node.position?.start?.offset ?? 0;
  let recoveredOffset = INLINE_PARSE_PREFIX.length;
  for (const line of value.split("\n")) {
    const start = markdown.indexOf(line, originalOffset);
    if (start === -1) break;
    for (let index = 0; index <= line.length; index += 1)
      offsets.set(recoveredOffset + index, start + index);
    originalOffset = start + line.length + 1;
    recoveredOffset += line.length + 1;
  }
  const point = (position: NonNullable<MarkdownPosition["start"]>) => {
    const offset =
      position.offset === undefined
        ? undefined
        : offsets.get(Math.max(INLINE_PARSE_PREFIX.length, position.offset));
    if (offset === undefined) return position;
    const lines = markdown.slice(0, offset).split("\n");
    return { offset, line: lines.length, column: lines.at(-1)!.length + 1 };
  };
  const restorePositions = (child: MarkdownAstNode) => {
    if (child.position)
      Object.assign(child, {
        position: {
          ...(child.position.start ? { start: point(child.position.start) } : {}),
          ...(child.position.end ? { end: point(child.position.end) } : {}),
        },
      });
    child.children?.forEach(restorePositions);
  };
  const first = recovered.blocks[0];
  return {
    ...recovered,
    restorePositions: () => recovered.blocks.forEach(restorePositions),
    blocks:
      first && node.position
        ? [{ ...first, position: node.position }, ...recovered.blocks.slice(1)]
        : recovered.blocks,
  };
}

// CommonMark treats four or more spaces after a list marker as code.
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
      if (!node.children.some((child) => isSameLineOverIndentedCode(child, node, source))) {
        for (const child of node.children) visit(child, source);
        return;
      }
      node.children = node.children.flatMap((child) => {
        if (isSameLineOverIndentedCode(child, node, source)) {
          const recovered = blocksFromIndentedCode(child, this, source);
          for (const block of recovered.blocks) {
            visit(block, recovered.source);
          }
          recovered.restorePositions?.();
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
