import { parseMarkdownWithMath } from "@t3tools/shared/markdownMath";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";

type ParsedNode = ReturnType<typeof parseMarkdownWithMath>;
type ChildNode = ParsedNode["children"][number];

/** Protect TeX from the native parser's Markdown escapes using opaque code spans. */
export function parseNativeMarkdownMath(
  markdown: string,
  parse: (source: string) => MarkdownNode,
): MarkdownNode {
  if (!/\\[([]|\$\$|(?:`{3,}|~{3,})[ \t]*math\b/.test(markdown)) return parse(markdown);

  let prefix = "t3-math:";
  while (markdown.includes(prefix)) prefix += ":";
  // Authored backticks, including unmatched ones, cannot close a placeholder.
  let fenceLength = 1;
  for (const [run] of markdown.matchAll(/`+/g)) {
    fenceLength = Math.max(fenceLength, run.length + 1);
  }
  const fence = "`".repeat(fenceLength);
  const formulas = new Map<string, MarkdownNode>();
  let source = "";
  let offset = 0;
  const visit = (node: ParsedNode | ChildNode): void => {
    if (
      node.type === "math" ||
      node.type === "inlineMath" ||
      (node.type === "code" && node.lang === "math")
    ) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const marker = `${prefix}${formulas.size}`;
      formulas.set(marker, {
        type:
          node.type !== "inlineMath" || markdown.startsWith("\\[", start)
            ? "math_block"
            : "math_inline",
        content: node.value,
      });
      source += markdown.slice(offset, start);
      // Adjacent closing/opening backticks merge into one CommonMark delimiter.
      if (source.endsWith("`")) source += " ";
      source += `${fence}${marker}${fence}`;
      if (markdown[end] === "`") source += " ";
      offset = end;
    } else if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  };
  visit(parseMarkdownWithMath(markdown));
  if (formulas.size === 0) return parse(markdown);
  source += markdown.slice(offset);
  const restore = (node: MarkdownNode): MarkdownNode => {
    if (node.type === "code_inline") {
      const content = node.content ?? node.children?.map((child) => child.content ?? "").join("");
      const formula = formulas.get(content ?? "");
      if (formula) return { ...node, ...formula, children: [] };
    }
    return node.children ? { ...node, children: node.children.map(restore) } : node;
  };
  return restore(parse(source));
}

export function containsNativeMath(node: MarkdownNode): boolean {
  return (
    node.type === "math_inline" ||
    node.type === "math_block" ||
    (node.children ?? []).some(containsNativeMath)
  );
}
