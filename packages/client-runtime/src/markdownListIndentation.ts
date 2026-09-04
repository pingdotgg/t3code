interface MarkdownPoint {
  readonly line?: number;
  readonly column?: number;
  readonly offset?: number;
}

interface MarkdownPosition {
  readonly start: MarkdownPoint;
  readonly end: MarkdownPoint;
}

interface MarkdownAstNode {
  readonly type: string;
  value?: unknown;
  position?: MarkdownPosition;
  children?: MarkdownAstNode[];
}

interface MarkdownFile {
  readonly value?: unknown;
}

interface MarkdownParser {
  parse(markdown: string): unknown;
}

const INLINE_PARSE_PREFIX = "t3-markdown-inline-prefix:";

function lineRanges(value: string) {
  const lines: { start: number; end: number; next: number }[] = [];
  let start = 0;
  for (const match of value.matchAll(/\r\n|\r|\n/g)) {
    const next = match.index + match[0].length;
    lines.push({ start, end: match.index, next });
    start = next;
  }
  lines.push({ start, end: value.length, next: value.length });
  return lines;
}

/** Indented code removes line prefixes but otherwise preserves each line's literal suffix. */
function codeSourceOffsets(node: MarkdownAstNode, source: string): number[] | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (typeof node.value !== "string" || start === undefined || end === undefined) return null;

  const value = node.value;
  const original = source.slice(start, end);
  const valueLines = lineRanges(value);
  const sourceLines = lineRanges(original);
  if (valueLines.length !== sourceLines.length) return null;

  const offsets: number[] = [];
  for (const [index, line] of valueLines.entries()) {
    const sourceLine = sourceLines[index];
    if (!sourceLine) return null;
    const text = value.slice(line.start, line.end);
    const indentLength = /^[\t ]*/.exec(text)?.[0].length ?? 0;
    const literal = text.slice(indentLength);
    let sourceCursor = sourceLine.end - literal.length;
    if (
      sourceCursor < sourceLine.start ||
      original.slice(sourceCursor, sourceLine.end) !== literal ||
      (line.end === line.next) !== (sourceLine.end === sourceLine.next)
    ) {
      return null;
    }

    for (let column = indentLength; column <= text.length; column += 1) {
      offsets[line.start + column] = start + sourceCursor + column - indentLength;
    }
    for (let column = indentLength - 1; column >= 0; column -= 1) {
      sourceCursor -= 1;
      if (sourceCursor < sourceLine.start) return null;
      if (original[sourceCursor] === text[column]) {
        offsets[line.start + column] = start + sourceCursor;
      } else if (original[sourceCursor] === "\t" && /^ *$/.test(text.slice(0, column + 1))) {
        // Consuming indentation can leave part of a tab as generated spaces.
        for (let remaining = 0; remaining <= column; remaining += 1) {
          offsets[line.start + remaining] = start + sourceCursor;
        }
        break;
      } else {
        return null;
      }
    }
    for (let offset = line.end; offset < line.next; offset += 1) {
      offsets[offset] =
        start + sourceLine.end + Math.min(offset - line.end, sourceLine.next - sourceLine.end - 1);
    }
  }
  return offsets;
}

function isSameLineOverIndentedCode(
  node: MarkdownAstNode,
  parent: MarkdownAstNode,
  markdown: string,
): boolean {
  if (
    node.type !== "code" ||
    parent.type !== "listItem" ||
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

function recoverIndentedCode(
  node: MarkdownAstNode,
  parser: MarkdownParser,
  source: string,
  pointAt: (offset: number) => MarkdownPoint,
): MarkdownAstNode[] | null {
  const offsets = codeSourceOffsets(node, source);
  if (!offsets || typeof node.value !== "string") return null;
  const value = node.value.trim();
  const trimStart = node.value.length - node.value.trimStart().length;
  // The prefix keeps block-looking first-line content inline while retaining
  // the processor's configured grammar, including citation tokens and GFM.
  const recoveredSource = `${INLINE_PARSE_PREFIX}${value}`;
  const document = parser.parse(recoveredSource) as MarkdownAstNode;
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
    return null;
  }

  first.value = first.value.slice(INLINE_PARSE_PREFIX.length);
  if (!first.value) children.shift();

  const originalPoint = (point: MarkdownPoint) => {
    if (point.offset === undefined) return null;
    const valueOffset = trimStart + Math.max(0, point.offset - INLINE_PARSE_PREFIX.length);
    const originalOffset = offsets[valueOffset];
    return originalOffset === undefined ? null : pointAt(originalOffset);
  };
  const remap = (current: MarkdownAstNode): boolean => {
    if (current.position) {
      const start = originalPoint(current.position.start);
      const end = originalPoint(current.position.end);
      if (!start || !end) return false;
      current.position = { start, end };
    }
    return current.children?.every(remap) ?? true;
  };
  // Preserve node identity for syntax extensions that associate metadata with nodes.
  return remap(document) ? blocks : null;
}

/**
 * Recover accidental same-line list alignment without changing explicit fences
 * or conventional indented code. Recovered positions still address the input,
 * so later plugins can safely replace source ranges or recognize a streaming tail.
 */
function attachListItemIndentationNormalizer(this: MarkdownParser) {
  return (tree: unknown, file: MarkdownFile) => {
    if (typeof file.value !== "string") return;
    const source = file.value;
    let sourceLineStarts: number[] | undefined;
    const pointAt = (offset: number) => {
      sourceLineStarts ??= lineRanges(source).map((line) => line.start);
      let low = 0;
      let high = sourceLineStarts.length;
      while (low + 1 < high) {
        const middle = (low + high) >>> 1;
        if ((sourceLineStarts[middle] ?? 0) <= offset) low = middle;
        else high = middle;
      }
      return { line: low + 1, column: offset - (sourceLineStarts[low] ?? 0) + 1, offset };
    };

    const visit = (node: MarkdownAstNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (isSameLineOverIndentedCode(child, node, source)) {
          const recovered = recoverIndentedCode(child, this, source, pointAt);
          if (recovered) {
            recovered.forEach(visit);
            return recovered;
          }
        }
        visit(child);
        return [child];
      });
    };

    visit(tree as MarkdownAstNode);
  };
}

export const remarkNormalizeListItemIndentation = attachListItemIndentationNormalizer;
