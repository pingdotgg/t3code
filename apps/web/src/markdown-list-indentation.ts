interface MarkdownPosition {
  readonly start?: {
    readonly line?: number;
    readonly column?: number;
    readonly offset?: number;
  };
  readonly end?: {
    readonly line?: number;
    readonly column?: number;
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

interface RecoveredIndentedMarkdown extends RecoveredMarkdown {
  readonly rebase: () => MarkdownAstNode[];
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

function lineSlices(value: string): Array<{ readonly start: number; readonly text: string }> {
  const lines: Array<{ readonly start: number; readonly text: string }> = [];
  let start = 0;
  for (let index = 0; index <= value.length; index += 1) {
    if (index === value.length || value[index] === "\n") {
      lines.push({ start, text: value.slice(start, index) });
      start = index + 1;
    }
  }
  return lines;
}

function recoveredOffsetMapper(
  value: string,
  node: MarkdownAstNode,
  markdown: string,
):
  | ((
      offset: number,
    ) => { readonly offset: number; readonly line: number; readonly column: number } | undefined)
  | null {
  const nodeStartPoint = node.position?.start;
  const nodeStart = nodeStartPoint?.offset;
  const nodeEnd = node.position?.end?.offset;
  if (!nodeStartPoint || nodeStart === undefined || nodeEnd === undefined) return null;

  const recoveredLines = lineSlices(value);
  const sourceLines = lineSlices(markdown.slice(nodeStart, nodeEnd));
  const mappings: Array<{
    readonly recoveredStart: number;
    readonly recoveredEnd: number;
    readonly sourceStart: number;
    readonly sourceLine: number;
    readonly sourceColumn: number;
  }> = [];
  let sourceLineIndex = 0;
  for (const recoveredLine of recoveredLines) {
    let matched = false;
    while (sourceLineIndex < sourceLines.length) {
      const sourceLine = sourceLines[sourceLineIndex];
      sourceLineIndex += 1;
      if (!sourceLine) continue;
      const column =
        recoveredLine.text.length === 0
          ? sourceLine.text.trim().length === 0
            ? sourceLine.text.length
            : -1
          : sourceLine.text.lastIndexOf(recoveredLine.text);
      if (column < 0) continue;
      mappings.push({
        recoveredStart: recoveredLine.start,
        recoveredEnd: recoveredLine.start + recoveredLine.text.length,
        sourceStart: nodeStart + sourceLine.start + column,
        sourceLine: (nodeStartPoint.line ?? 1) + sourceLineIndex - 1,
        sourceColumn: sourceLineIndex === 1 ? (nodeStartPoint.column ?? 1) + column : column + 1,
      });
      matched = true;
      break;
    }
    if (!matched) return null;
  }

  return (offset) => {
    const relativeOffset = offset - INLINE_PARSE_PREFIX.length;
    let low = 0;
    let high = mappings.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const mapping = mappings[middle];
      if (!mapping) return undefined;
      if (relativeOffset < mapping.recoveredStart) {
        high = middle - 1;
      } else if (relativeOffset > mapping.recoveredEnd) {
        low = middle + 1;
      } else {
        const columnOffset = relativeOffset - mapping.recoveredStart;
        return {
          offset: mapping.sourceStart + columnOffset,
          line: mapping.sourceLine,
          column: mapping.sourceColumn + columnOffset,
        };
      }
    }
    return undefined;
  };
}

function rebaseRecoveredOffsets(
  node: MarkdownAstNode,
  mapOffset: (
    offset: number,
  ) => { readonly offset: number; readonly line: number; readonly column: number } | undefined,
): MarkdownAstNode {
  const rebasePoint = (point: {
    readonly line?: number;
    readonly column?: number;
    readonly offset?: number;
  }) => {
    if (point.offset === undefined) return point;
    const mapped = mapOffset(point.offset);
    return mapped === undefined ? undefined : { ...point, ...mapped };
  };
  const start = node.position?.start ? rebasePoint(node.position.start) : undefined;
  const end = node.position?.end ? rebasePoint(node.position.end) : undefined;
  const { position: _position, ...nodeWithoutPosition } = node;
  return {
    ...nodeWithoutPosition,
    ...(start || end ? { position: { ...(start ? { start } : {}), ...(end ? { end } : {}) } } : {}),
    ...(node.children
      ? { children: node.children.map((child) => rebaseRecoveredOffsets(child, mapOffset)) }
      : {}),
  };
}

function blocksFromIndentedCode(
  node: MarkdownAstNode,
  parser: MarkdownParser,
  markdown: string,
): RecoveredIndentedMarkdown {
  const value = typeof node.value === "string" ? node.value.trim() : "";
  const recovered = parseRecoveredMarkdown(value, parser);
  const mapOffset = recoveredOffsetMapper(value, node, markdown);
  return {
    ...recovered,
    rebase: () => {
      const rebasedBlocks = mapOffset
        ? recovered.blocks.map((block) => rebaseRecoveredOffsets(block, mapOffset))
        : recovered.blocks;
      const first = rebasedBlocks[0];
      return first && node.position
        ? ([
            { ...first, position: node.position },
            ...rebasedBlocks.slice(1),
          ] satisfies MarkdownAstNode[])
        : rebasedBlocks;
    },
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
          const recovered = blocksFromIndentedCode(child, this, source);
          for (const block of recovered.blocks) {
            visit(block, recovered.source);
          }
          return recovered.rebase();
        }
        visit(child, source);
        return [child];
      });
    };

    visit(tree, markdown);
  };
}

export const remarkNormalizeListItemIndentation = attachListItemIndentationNormalizer;
