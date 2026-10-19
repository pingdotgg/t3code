/// <reference types="mdast-util-to-hast" />
import type { Root } from "mdast";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { unified } from "unified";

const mathParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath, { singleDollarTextMath: true })
  .freeze();

export function parseMarkdownWithMath(source: string) {
  return mathParser.parse(source);
}

/** Closed, parser-owned formulas with authored source for editors. */
export function markdownMathRanges(source: string, tree?: Root) {
  const ranges: Array<{
    start: number;
    end: number;
    source: string;
    tex: string;
    display: boolean;
    inTable: boolean;
  }> = [];
  if (!mayContainMath(source)) return ranges;
  const visit = (node: Root | Root["children"][number], inTable = false) => {
    const table = inTable || node.type === "tableCell";
    if (
      node.type === "math" ||
      node.type === "inlineMath" ||
      (node.type === "code" && node.lang === "math")
    ) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const authored = source.slice(start, end);
      if (node.type === "code") {
        const open = /^[ \t]*(`{3,}|~{3,})/.exec(authored)?.[1];
        const close = /\n[ \t>]*(`{3,}|~{3,})[ \t\r]*$/.exec(authored)?.[1];
        if (!open || !close || open[0] !== close[0] || close.length < open.length) return;
      }
      const display = node.type !== "inlineMath" || /^(?:\$\$|\\\[)/.test(authored);
      ranges.push({ start, end, source: authored, tex: node.value, display, inTable: table });
    } else if ("children" in node) node.children.forEach((child) => visit(child, table));
  };
  visit(tree ?? parseMarkdownWithMath(source));
  return ranges;
}

/** Messages without these characters skip math parsing entirely. */
function mayContainMath(text: string): boolean {
  return (
    text.includes("$") ||
    text.includes("\\(") ||
    text.includes("\\[") ||
    /(?:`{3,}|~{3,})[ \t]*math\b/.test(text)
  );
}

export function mathKind(className: string | undefined): "inline" | "display" | null {
  if (!className?.includes("language-math")) return null;
  if (className.includes("math-display")) return "display";
  return className.includes("math-inline") ? "inline" : null;
}
