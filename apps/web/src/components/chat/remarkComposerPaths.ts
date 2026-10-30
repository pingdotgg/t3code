import type { Nodes, Root } from "mdast";
import type { VFile } from "vfile";
import { composerUnderscoreWordReader } from "~/composer-rich-text";

export function remarkComposerPaths() {
  return (tree: Root, file: VFile) => {
    const text = file.toString();
    if (!text.includes("_")) return;
    const wordAt = composerUnderscoreWordReader(text);
    const visit = (node: Nodes) => {
      if (!("children" in node) || node.type === "link" || node.type === "linkReference") return;
      if (node.type === "strong" || node.type === "emphasis") {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start !== undefined && end !== undefined && text[start] === "_") {
          const word = wordAt(start);
          if (word.literal && end <= word.end) {
            const delimiter = node.type === "strong" ? "__" : "_";
            node.data = { ...node.data, hName: "span" };
            node.children.unshift({ type: "text", value: delimiter });
            node.children.push({ type: "text", value: delimiter });
          }
        }
      }
      node.children.forEach(visit);
    };
    visit(tree);
  };
}
