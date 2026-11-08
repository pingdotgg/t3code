import { changeRequestReferenceAutolinker } from "@t3tools/client-runtime/pull-request-markdown";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { remarkPullRequestAutolinks } from "./pullRequestMarkdown.logic";

type Node = {
  type: string;
  value?: string;
  url?: string;
  data?: { hProperties?: Record<string, unknown> };
  children?: Node[];
};

function links(markdown: string) {
  const autolinks = changeRequestReferenceAutolinker({
    provider: "github",
    url: "https://github.com/team/repo/pull/8",
  })!;
  const tree = unified().use(remarkParse).parse(markdown) as Node;
  remarkPullRequestAutolinks({ autolinks })(tree as never);
  const found: Array<[string | undefined, string | undefined, unknown]> = [];
  const visit = (node: Node) => {
    if (node.type === "link") {
      found.push([
        node.children?.[0]?.value,
        node.url,
        node.data?.hProperties?.["dataPullRequestAutolink"],
      ]);
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return found;
}

describe("remarkPullRequestAutolinks", () => {
  it("links the host's references in prose and leaves links and code alone", () => {
    expect(links("Fixes #12 in **abcdef1**. [#13](https://example.com) `#14`")).toEqual([
      ["#12", "https://github.com/team/repo/issues/12", "reference"],
      ["abcdef1", "https://github.com/team/repo/commit/abcdef1", "commit"],
      ["#13", "https://example.com", undefined],
    ]);
  });
});
