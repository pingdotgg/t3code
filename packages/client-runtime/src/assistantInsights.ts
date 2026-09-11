import remarkParse from "remark-parse";
import { unified } from "unified";

const parser = unified().use(remarkParse);
const insightStart = /^([\t ]*)(`?)★ Insight[\t ]+─+\2[\t ]*$/u;
const insightEnd = /^[\t ]*(`?)─+\1[\t ]*$/u;

type MarkdownNode = {
  type: string;
  position?: { start: { line: number }; end: { line: number } } | undefined;
  children?: readonly MarkdownNode[] | undefined;
};

/** Render Claude's insight fences as quotes without changing stored assistant text. */
export function renderAssistantInsightsAsMarkdown(markdown: string): string {
  if (!markdown.includes("★ Insight")) return markdown;

  const literalLines = new Set<number>();
  const softBreakLines = new Set<number>();
  function visit(node: MarkdownNode) {
    const position = node.position;
    if (position) {
      const { start, end } = position;
      // Single-line code spans can be the plugin's backtick-wrapped delimiters.
      if (
        node.type === "code" ||
        node.type === "html" ||
        (node.type === "inlineCode" && start.line !== end.line)
      ) {
        for (let line = start.line; line <= end.line; line++) literalLines.add(line);
        return;
      }
      if (node.type === "text") {
        for (let line = start.line; line < end.line; line++) softBreakLines.add(line);
      }
    }
    node.children?.forEach(visit);
  }
  visit(parser.parse(markdown));

  const lines = markdown.split(/\r\n|\r|\n/u);
  const output: string[] = [];
  let insightIndent: string | undefined;
  let changed = false;
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const literal = literalLines.has(lineNumber);
    const start = literal ? null : insightStart.exec(line);
    if (start) {
      insightIndent = start[1] ?? "";
      output.push("", `${insightIndent}> **★ Insight**`, `${insightIndent}>`);
      changed = true;
    } else if (insightIndent !== undefined && !literal && insightEnd.test(line)) {
      output.push("");
      insightIndent = undefined;
    } else if (insightIndent !== undefined) {
      // Hard breaks belong only to insight prose; code and surrounding prose stay intact.
      const hardBreak = !literal && line.trim() !== "" && softBreakLines.has(lineNumber);
      const content = line.startsWith(insightIndent) ? line.slice(insightIndent.length) : line;
      output.push(`${insightIndent}> ${content}${hardBreak ? "  " : ""}`);
    } else {
      output.push(line);
    }
  }
  return changed ? output.join("\n") : markdown;
}
