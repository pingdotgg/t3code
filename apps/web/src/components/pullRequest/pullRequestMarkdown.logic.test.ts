import { changeRequestReferenceAutolinker } from "@t3tools/client-runtime/pull-request-markdown";
import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
  CHAT_MARKDOWN_REHYPE_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestCommentPreview, rehypePullRequestAutolinks } from "./pullRequestMarkdown.logic";

type Node = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
};

function links(markdown: string, { breaks = false } = {}) {
  const autolinks = changeRequestReferenceAutolinker({
    provider: "github",
    url: "https://github.com/team/repo/pull/8",
  })!;
  const processor = unified()
    .use(remarkParse)
    .use(breaks ? CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS : CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS)
    .use(rehypePullRequestAutolinks, { autolinks });
  const tree = processor.runSync(processor.parse(markdown), { value: markdown }) as Node;
  const found: Array<[string | undefined, string | undefined, unknown]> = [];
  const visit = (node: Node) => {
    if (node.tagName === "a") {
      found.push([
        node.children?.[0]?.value,
        String(node.properties?.href),
        node.properties?.dataPullRequestAutolink,
      ]);
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return found;
}

describe("rehypePullRequestAutolinks", () => {
  it("links the host's references in prose and leaves links and code alone", () => {
    expect(links("Fixes #12 in **abcdef1**. [#13](https://example.com) `#14`")).toEqual([
      ["#12", "https://github.com/team/repo/issues/12", "reference"],
      ["abcdef1", "https://github.com/team/repo/commit/abcdef1", "commit"],
      ["#13", "https://example.com", undefined],
    ]);
  });
});

describe("authored mentions after sanitizing HTML", () => {
  it.each(["\\@", "&#64;", "&#x40;", "&commat;"])(
    "keeps %s literal and links a following occurrence",
    (at) => {
      expect(links(`${at}reader @reader ${at}team/reviewers @team/reviewers`)).toEqual([
        ["@reader", "https://github.com/reader", "mention"],
        ["@team/reviewers", "https://github.com/orgs/team/teams/reviewers", "mention"],
      ]);
    },
  );
  it("links mentions in sanitized details and tables, skipping existing links and code", () => {
    expect(
      links(
        '<details><summary>@reader</summary><table><tr><td>&#64;reader @team/reviewers</td></tr></table><code>@code</code><a href="https://example.com">@existing</a></details>',
      ),
    ).toEqual([
      ["@reader", "https://github.com/reader", "mention"],
      ["@team/reviewers", "https://github.com/orgs/team/teams/reviewers", "mention"],
      ["@existing", "https://example.com", undefined],
    ]);
  });
  it("does not link entity-authored login characters", () => {
    expect(links("@rea&#100;er @reader")).toEqual([
      ["@reader", "https://github.com/reader", "mention"],
    ]);
  });
  it.each([
    "line one\ncc \\@other @reader",
    "> quote\n> \\@other @reader",
    "- item\n  \\@other @reader",
  ])("checks mentions in text split at hard line breaks: %s", (markdown) => {
    expect(links(markdown, { breaks: true })).toEqual([
      ["@reader", "https://github.com/reader", "mention"],
    ]);
  });
  it("preserves authored mentions after recovering an over-indented list", () => {
    expect(links("Thanks \\@team, see below.\n\n-         \\@reader &#64;reader @reader")).toEqual([
      ["@reader", "https://github.com/reader", "mention"],
    ]);
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
