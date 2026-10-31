import { changeRequestReferenceAutolinker } from "@t3tools/client-runtime/pull-request-markdown";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestAttachments, remarkPullRequestAutolinks } from "./pullRequestMarkdown.logic";

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

describe("pullRequestAttachments", () => {
  it("collects body media and image references once while leaving code alone", () => {
    expect(
      pullRequestAttachments(
        [
          "![Before](https://example.com/before.png)",
          "![Again](https://example.com/before.png)",
          "![After][result]",
          "",
          "[result]: https://example.com/after.png",
          "",
          "https://example.com/demo.mp4",
          "",
          "```md",
          "![Code](https://example.com/code.png)",
          "```",
          "    ![Indented](https://example.com/indented.png)",
          "![Unsafe](javascript:alert)",
          '<img src="https://example.com/screenshot.png" alt="Screenshot" />',
        ].join("\n"),
      ),
    ).toEqual([
      { url: "https://example.com/before.png", media: "image", caption: "Image 1" },
      { url: "https://example.com/after.png", media: "image", caption: "Image 2" },
      { url: "https://example.com/demo.mp4", media: "video", caption: "Video 3" },
      { url: "https://example.com/screenshot.png", media: "image", caption: "Image 4" },
    ]);
  });
});
