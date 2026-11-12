import { changeRequestReferenceAutolinker } from "@t3tools/client-runtime/pull-request-markdown";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import {
  pullRequestCommentPreview,
  pullRequestMarkdownPlugins,
  remarkPullRequestAutolinks,
} from "./pullRequestMarkdown.logic";

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

describe("pullRequestMarkdownPlugins", () => {
  it("renders the host's emoji shortcodes as emoji", async () => {
    const processor = unified()
      .use(remarkParse)
      .use(
        pullRequestMarkdownPlugins({
          provider: "github",
          url: "https://github.com/team/repo/pull/8",
        }),
      );
    const tree = (await processor.run(processor.parse("Nice :thumbsup: :tada: `:tada:`"))) as Node;
    const text: string[] = [];
    const visit = (node: Node) => {
      if (node.value !== undefined) text.push(node.value);
      node.children?.forEach(visit);
    };
    visit(tree);
    expect(text.join("")).toBe("Nice 👍 🎉 :tada:");

    const withLinks = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(
        pullRequestMarkdownPlugins({
          provider: "github",
          url: "https://github.com/team/repo/pull/8",
        }),
      );
    const linked = (await withLinks.run(
      withLinks.parse(
        "https://example.com/:tada:/ <https://example.com/:tada:/> [:tada: docs](https://example.com) <code>:tada:</code>",
      ),
    )) as Node;
    text.length = 0;
    visit(linked);
    expect(text.join("")).toBe(
      "https://example.com/:tada:/ https://example.com/:tada:/ 🎉 docs <code>:tada:</code>",
    );
  });
});

describe("pullRequestCommentPreview", () => {
  it.each([
    ["<!-- hidden -->\n> [!WARNING]\n**Guard** [this](https://example.com).", "Guard this."],
    [
      '<a href="https://example.com"><img src="badge.svg" /></a>\n<strong>Tasks keep the wrong computer</strong>',
      "Tasks keep the wrong computer",
    ],
    [
      "<details><summary>Review &amp; fixes</summary><p>First<br>Second</p></details>",
      "Review & fixes First Second",
    ],
    ['<p title="value > limit">Keep <strong>this</strong> readable.</p>', "Keep this readable."],
    [
      "Use `<div>` and `Promise<void>`.\n\n```html\n<span>example</span>\n```",
      "Use <div> and Promise<void>. <span>example</span>",
    ],
    ["![badge](https://example.com/badge.svg) **Review**", "badge Review"],
    ["```md\n[!TIP]\n> [!WARNING]\n```\n\n    [!NOTE]", "[!TIP] > [!WARNING] [!NOTE]"],
    [
      "Review :codex-file-citation{purpose='output'} safely.",
      "Review :codex-file-citation{purpose='output'} safely.",
    ],
    [":codex-followup[Prepare **print** version]", ":codex-followup[Prepare **print** version]"],
  ])("extracts readable text from %s", (body, expected) => {
    expect(pullRequestCommentPreview(body)).toBe(expected);
  });
});
