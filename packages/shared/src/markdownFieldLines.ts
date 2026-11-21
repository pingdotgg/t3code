import type { Nodes, RootContent } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

// `Label: value`, also with the label in bold or italics (`**Label:** value`, `*Label*: value`).
const ASSISTANT_FIELD_LINE = /^(\*{1,2}|_{1,2})?[\p{L}][\p{L}\p{N} /_-]{0,31}(?:\1:|:\1)[ \t]+\S/u;
const LINE_BREAK = /\r\n?|\n/;

/** A multi-line top-level paragraph whose every line is a `Label: value` field. */
export function isAssistantFieldParagraph(node: RootContent, source: string): boolean {
  if (node.type !== "paragraph" || !node.position) return false;
  const { start, end } = node.position;
  return (
    start.line !== end.line &&
    start.offset !== undefined &&
    end.offset !== undefined &&
    source
      .slice(start.offset, end.offset)
      .split(LINE_BREAK)
      .every((line) => ASSISTANT_FIELD_LINE.test(line))
  );
}

const parser = unified().use(remarkParse);

/** Source-level form of the field-line rule, for renderers that cannot break one paragraph's soft breaks. */
export function hardBreakAssistantFieldLines(markdown: string): string {
  const lines = markdown.split(LINE_BREAK);
  if (
    !lines.some(
      (line, index) =>
        ASSISTANT_FIELD_LINE.test(line) && ASSISTANT_FIELD_LINE.test(lines[index + 1] ?? ""),
    )
  ) {
    return markdown;
  }
  const softBreaks: number[] = [];
  for (const node of parser.parse(markdown).children) {
    if (isAssistantFieldParagraph(node, markdown)) collectSoftBreaks(node, markdown, softBreaks);
  }
  let result = "";
  let offset = 0;
  for (const position of softBreaks) {
    result += `${markdown.slice(offset, position)}  `;
    offset = position;
  }
  return result + markdown.slice(offset);
}

// Soft breaks are the newlines inside text nodes; inline code and `break` nodes keep their source.
function collectSoftBreaks(node: Nodes, source: string, into: number[]): void {
  if (node.type === "text") {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    for (const match of source.slice(start, end).matchAll(/\r\n?|\n/g)) {
      into.push(start + match.index);
    }
    return;
  }
  if ("children" in node) {
    for (const child of node.children) collectSoftBreaks(child, source, into);
  }
}
