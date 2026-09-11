import type { Root, RootContent } from "mdast";
import type { Parser as UnifiedParser, Plugin } from "unified";

type Parser = UnifiedParser<Root>;

interface ParsedPrefix {
  source: string;
  offset: number;
  line: number;
  children: RootContent[];
}

function hasDefinitions(node: Root | RootContent): boolean {
  return (
    node.type === "definition" ||
    node.type === "footnoteDefinition" ||
    ("children" in node && node.children.some((child) => hasDefinitions(child)))
  );
}

function shiftPositions(node: Root | RootContent, offset: number, lines: number): void {
  if (node.position) {
    for (const point of [node.position.start, node.position.end]) {
      if (point.offset !== undefined) point.offset += offset;
      point.line += lines;
    }
  }
  if ("children" in node) {
    for (const child of node.children) shiftPositions(child, offset, lines);
  }
}

/** Keep the full document pipeline while avoiding parsing a completed code-heavy
 * prefix on every token. A closed top-level fence followed by a blank line is a
 * parsing boundary. Definitions are document-wide, so they require a full parse.
 */
export function createIncrementalMarkdownParser(parse: Parser): Parser {
  let cached: ParsedPrefix | undefined;

  return (source, file) => {
    // A streaming CR can become half of a CRLF. A BOM at the suffix boundary
    // would be stripped by a new parser although it is inside the full document.
    if (source.includes("\r") || source.includes("\uFEFF")) return parse(source, file);

    const prefix = cached && source.startsWith(cached.source) ? cached : undefined;
    let root: Root;
    if (prefix) {
      root = parse(source.slice(prefix.offset), file);
      if (hasDefinitions(root)) return parse(source, file);
      shiftPositions(root, prefix.offset, prefix.line - 1);
      if (root.position) root.position.start = { line: 1, column: 1, offset: 0 };
      // Remark transforms mutate their input. The cache owns pristine nodes and
      // each render receives its own copy, including source positions.
      root.children.unshift(...structuredClone(prefix.children));
    } else {
      root = parse(source, file);
      if (hasDefinitions(root)) return root;
    }

    for (let index = root.children.length - 1; index >= 0; index--) {
      const node = root.children[index];
      if (node?.type !== "code") continue;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) continue;
      if (prefix && end < prefix.offset) break;
      const value = source.slice(start, end);
      const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(value)?.[1];
      if (!opening) continue;
      const lastLine = value.slice(value.lastIndexOf("\n") + 1);
      const closing = new RegExp(`^ {0,3}${opening[0]}{${opening.length},}[ \\t]*$`);
      const separator = /^\n[ \t]*\n/.exec(source.slice(end))?.[0];
      if (!closing.test(lastLine) || !separator) continue;
      const offset = end + separator.length;
      cached = {
        source: source.slice(0, offset),
        offset,
        line: node.position!.end.line + 2,
        children: structuredClone(root.children.slice(0, index + 1)),
      };
      break;
    }
    return root;
  };
}

/** One cache per streaming renderer. Extra syntax plugins must use the normal
 * parser because their document-wide dependencies are not known here.
 */
export function createIncrementalMarkdownPlugin(): Plugin<[], Root> {
  let parser: Parser | undefined;
  return function () {
    const original = this.parser;
    if (!original) return;
    parser ??= createIncrementalMarkdownParser((source, file) => original(source, file) as Root);
    this.parser = parser;
  };
}
