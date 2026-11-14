import type { Root, RootContent } from "mdast";
import type { PluggableList } from "unified";
import type { VFile } from "vfile";

/** An option is a button label: its formulas are typeset, every other character stays as written. */
export function remarkOptionText() {
  return (tree: Root, file: VFile) => {
    const source = String(file);
    const children: RootContent[] = [];
    let offset = 0;
    const visit = (node: Root | RootContent) => {
      if (node.type === "math" || node.type === "inlineMath") {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start === undefined || end === undefined) return;
        if (start > offset) children.push({ type: "text", value: source.slice(offset, start) });
        offset = end;
        children.push({
          type: "inlineMath",
          value: node.value,
          data: {
            hName: "code",
            hProperties: { className: ["language-math", "math-inline"] },
            hChildren: [{ type: "text", value: node.value }],
          },
        });
      } else if ("children" in node) node.children.forEach(visit);
    };
    visit(tree);
    if (offset < source.length) children.push({ type: "text", value: source.slice(offset) });
    tree.children = children;
  };
}

export const OPTION_TEXT_PLUGINS: PluggableList = [remarkOptionText];
