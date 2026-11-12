import type { Nodes } from "mdast";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { useClientSettings } from "../../hooks/useSettings";
import { MarkdownMath } from "./MarkdownMath";

const mathParser = unified().use(remarkParse).use(remarkMath, { singleDollarTextMath: true });

type Segment = string | { tex: string; display: boolean };

// Only math nodes are taken from the parse; all other text stays as its literal source.
function plainTextMathSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  const visit = (node: Nodes) => {
    if (node.type === "math" || node.type === "inlineMath") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      if (start > cursor) segments.push(text.slice(cursor, start));
      segments.push({ tex: node.value, display: node.type === "math" });
      cursor = end;
      return;
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(mathParser.runSync(mathParser.parse(text)) as Nodes);
  if (cursor < text.length) segments.push(text.slice(cursor));
  return segments;
}

/** Plain text that typesets its `$…$` math when Render math is on. */
export function PlainTextMath({ text }: { text: string }) {
  const mathEnabled = useClientSettings((settings) => settings.mathRenderingEnabled);
  if (!mathEnabled || !text.includes("$")) return text;
  return plainTextMathSegments(text).map((segment, index) =>
    typeof segment === "string" ? (
      segment
    ) : (
      // oxlint-disable-next-line react/no-array-index-key -- segments are derived from fixed text
      <MarkdownMath key={index} tex={segment.tex} display={segment.display} />
    ),
  );
}
