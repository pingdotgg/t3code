import type { Root } from "mdast";
import {
  markdownMathRanges,
  mayContainMath,
  parseMarkdownWithMath,
} from "@t3tools/shared/markdownMath";

/** Remove TeX line comments before folding whitespace, so a comment cannot
 * swallow the rest of a formula when MD4C receives it on one Markdown line. */
function mathOnOneLine(tex: string): string {
  let result = "";
  let slashes = 0;
  for (let index = 0; index < tex.length; index++) {
    const char = tex[index]!;
    if (char === "%" && slashes % 2 === 0) {
      index = tex.indexOf("\n", index);
      if (index === -1) break;
      slashes = 0;
      continue;
    }
    result += char;
    slashes = char === "\\" ? slashes + 1 : 0;
  }
  return result.replace(/\s*\n\s*/g, " ");
}

/** MD4C accepts dollar delimiters. Keep its native layout and rendering, while
 * sharing the web parser's delimiter, currency, code, and unfinished-math rules. */
export function enrichedMarkdownWithMath(source: string): string {
  if (!mayContainMath(source) && !source.includes("\\)") && !source.includes("\\]")) return source;
  const tree = parseMarkdownWithMath(source);
  const edits = markdownMathRanges(source, tree).map((range) => ({
    start: range.start,
    end: range.end,
    value:
      range.display && !range.inTable
        ? `$$${mathOnOneLine(range.tex)}$$`
        : `$${mathOnOneLine(range.tex)}$`,
  }));
  const visit = (node: Root | Root["children"][number]) => {
    if (node.type === "text") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      for (let index = start; index < end; index++) {
        if (source[index] === "\\" && "[]()".includes(source[index + 1] ?? "\0")) {
          let beforeSlashes = 0;
          for (let before = index - 1; before >= start && source[before] === "\\"; before--)
            beforeSlashes++;
          if (beforeSlashes % 2 === 0) {
            // The shared parser classified this as prose, such as a numeric citation.
            // Encode the bracket so native TeX parsing cannot reinterpret it as math.
            edits.push({
              start: index,
              end: index + 2,
              value: `&#${source.charCodeAt(index + 1)};`,
            });
            index++;
          }
          continue;
        }
        if (source[index] !== "$") continue;
        let slashes = 0;
        for (let before = index - 1; before >= start && source[before] === "\\"; before--)
          slashes++;
        if (slashes % 2 === 0) edits.push({ start: index, end: index + 1, value: "\\$" });
      }
    } else if ("children" in node) node.children.forEach(visit);
  };
  visit(tree);
  edits.sort((a, b) => a.start - b.start);
  let result = "";
  let offset = 0;
  for (const edit of edits) {
    if (edit.start < offset) continue;
    result += source.slice(offset, edit.start) + edit.value;
    offset = edit.end;
  }
  return result + source.slice(offset);
}
