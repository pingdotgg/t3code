import type { Nodes, Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS } from "@t3tools/shared/markdownPipeline";
import { remarkExplicitListNumbers } from "./markdown-explicit-list-numbers";

function orderedItemValues(markdown: string): Array<Array<unknown>> {
  const processor = unified()
    .use(remarkParse)
    .use([remarkExplicitListNumbers, ...CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS]);
  // The pipeline is an untyped plugin list, so `runSync` cannot infer the mdast root.
  const tree = processor.runSync(processor.parse(markdown), markdown) as Root;
  const lists: Array<Array<unknown>> = [];
  const visit = (node: Nodes) => {
    if (node.type === "list" && node.ordered) {
      lists.push(node.children.map((item) => item.data?.hProperties?.value));
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(tree);
  return lists;
}

describe("remarkExplicitListNumbers", () => {
  it("keeps every typed number that CommonMark would renumber", () => {
    expect(orderedItemValues("1. test\n5. test\n8. test\n15. test")).toEqual([
      [undefined, "5", "8", "15"],
    ]);
  });

  it("auto-numbers lists that repeat one number, as CommonMark shorthand", () => {
    expect(orderedItemValues("1. a\n1. b\n1. c\n\nnext\n\n0. a\n0. b")).toEqual([
      [undefined, undefined, undefined],
      [undefined, undefined],
    ]);
  });

  it("leaves lists recovered from over-indented list text numbered as CommonMark does", () => {
    expect(orderedItemValues("-       first block\n\n        1. one\n        5. five")).toEqual([
      [undefined, undefined],
    ]);
  });
});
