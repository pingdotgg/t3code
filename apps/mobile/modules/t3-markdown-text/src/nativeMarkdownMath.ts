import { markdownMathRanges } from "@t3tools/client-runtime/markdown-math";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";

/** Shield math from the native parser, then restore typed nodes using the shared grammar. */
export function parseNativeMarkdownMath(
  source: string,
  parse: (markdown: string) => MarkdownNode,
): MarkdownNode {
  const ranges = markdownMathRanges(source);
  if (ranges.length === 0) return parse(source);
  let prefix = ":t3-math-";
  while (source.includes(prefix)) prefix += "-";
  const mathByMarker = new Map(ranges.map((math, index) => [`${prefix}${index}:`, math]));
  // Text markers cannot merge with neighboring Markdown code-span delimiters.
  let cursor = 0;
  let protectedSource = "";
  for (const [marker, math] of mathByMarker) {
    protectedSource += source.slice(cursor, math.start) + marker;
    cursor = math.end;
  }
  protectedSource += source.slice(cursor);
  const markerPattern = new RegExp(`${prefix}\\d+:`, "g");
  function restore(node: MarkdownNode): MarkdownNode {
    if (!node.children) return node;
    return {
      ...node,
      children: node.children.flatMap((child) => {
        if (child.type !== "text" || !child.content) return [restore(child)];
        const restored: MarkdownNode[] = [];
        let offset = 0;
        for (const match of child.content.matchAll(markerPattern)) {
          const math = mathByMarker.get(match[0]);
          if (!math) continue;
          if (match.index > offset)
            restored.push({ ...child, content: child.content.slice(offset, match.index) });
          restored.push({
            type: math.math ? (math.math.display ? "math_block" : "math_inline") : "text",
            content: math.source,
            beg: math.start,
            end: math.end,
          });
          offset = match.index + match[0].length;
        }
        if (offset < child.content.length)
          restored.push({ ...child, content: child.content.slice(offset) });
        return restored;
      }),
    };
  }
  return restore(parse(protectedSource));
}
