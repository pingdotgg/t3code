import { keepLeadingWhitespace, keepsLeadingWhitespace } from "./markdownLeadingWhitespace.ts";
import { keepOrderedListNumbers, keepsOrderedListNumbers } from "./markdownOrderedListNumbers.ts";

interface MarkdownPosition {
  readonly start?: {
    readonly line?: number;
    readonly offset?: number;
  };
}

interface MarkdownAstNode {
  readonly type: string;
  readonly identifier?: unknown;
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

const INLINE_PARSE_PREFIX = "t3-markdown-inline-prefix ";

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
    parentStart.offset === undefined ||
    nodeStart.line !== parentStart.line
  ) {
    return false;
  }

  const sourceCharacter = markdown[nodeStart.offset];
  return sourceCharacter !== "`" && sourceCharacter !== "~";
}

function parseRecoveredMarkdown(value: string, parser: MarkdownParser, refs: string) {
  // Prefix block-looking input to parse inline extensions; retain later block children after blank lines.
  const source = `${refs}${INLINE_PARSE_PREFIX}${value}`;
  const document = parser.parse(source) as MarkdownAstNode;
  const blocks = document.children?.filter((n) => (n.position?.start?.offset ?? 0) >= refs.length);
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

/**
 * Indented code in an item starts five columns past the marker, so its tabs reach tab stops
 * measured from there. Expands the leading tabs up to the first line's content as the source
 * columns place them, since the recovered text is measured again from column zero.
 */
export function expandIndentedCodeTabs(value: string, source: string, start: number): string {
  if (!value.includes("\t")) return value;
  const columns = (text: string, from = 0) =>
    [...text].reduce((col, c) => col + (c === "\t" ? 4 - (col % 4) : 1), from);
  const marker = /^([-*+]|\d{1,9}[.)])/.exec(source.slice(start))![0];
  const before = source.slice(0, start);
  const prefix = before.slice(Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r")) + 1);
  const base = columns(prefix + marker) + 5;
  const end = columns(/^[\t ]*/.exec(value)![0], base);
  return value.replace(/^[\t ]+/gm, (indent) => {
    let col = base;
    let at = 0;
    while (at < indent.length && col < end) col = columns(indent[at++]!, col);
    return " ".repeat(col - base) + indent.slice(at);
  });
}

function blocksFromIndentedCode(
  node: MarkdownAstNode,
  parser: MarkdownParser,
  refs: string,
): RecoveredMarkdown {
  const value = typeof node.value === "string" ? node.value.trim() : "";
  const recovered = parseRecoveredMarkdown(value, parser, refs);
  if (keepsOrderedListNumbers(parser)) {
    for (const block of recovered.blocks) keepOrderedListNumbers(block, recovered.source);
  }
  if (keepsLeadingWhitespace(parser)) {
    // The trimmed first line sets where the item's content starts.
    const indent = /^[\t ]*/.exec(String(node.value))![0];
    const columns = [...indent].reduce(
      (column, character) => (character === "\t" ? (Math.floor(column / 4) + 1) * 4 : column + 1),
      0,
    );
    keepLeadingWhitespace({ type: "root", children: recovered.blocks }, recovered.source, columns);
  }
  const first = recovered.blocks[0];
  return {
    ...recovered,
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
    const identifiers: string[] = [];
    const collect = (node: MarkdownAstNode) => {
      if (node.type === "definition" && typeof node.identifier === "string") {
        identifiers.push(node.identifier);
      }
      node.children?.forEach(collect);
    };
    collect(tree);
    // micromark only parses `[text][label]` as a reference when the label is defined; the href
    // still comes from the document's own definition when mdast becomes hast. Stubs are limited
    // to labels the text can name, matched as mdast normalizes identifiers, to keep reparses small.
    const definitionsFor = (value: string) => {
      if (identifiers.length === 0) return "";
      const text = value
        .replace(/[\t\n\r ]+/g, " ")
        .toLowerCase()
        .toUpperCase()
        .toLowerCase();
      return identifiers
        .filter((identifier) => text.includes(identifier))
        .map((identifier) => `[${identifier}]: <>\n\n`)
        .join("");
    };

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
          const start = node.position!.start!.offset!;
          const value = expandIndentedCodeTabs(String(child.value), source, start);
          const recovered = blocksFromIndentedCode(
            { ...child, value },
            this,
            definitionsFor(value),
          );
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
