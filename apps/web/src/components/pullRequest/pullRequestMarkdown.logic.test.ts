import { changeRequestReferenceAutolinker } from "@t3tools/client-runtime/pull-request-markdown";
import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REHYPE_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { rehypePullRequestAutolinks } from "./pullRequestMarkdown.logic";

type Node = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
};

function links(markdown: string) {
  const autolinks = changeRequestReferenceAutolinker({
    provider: "github",
    url: "https://github.com/team/repo/pull/8",
  })!;
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
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
});

it("preserves authored mentions after recovering an over-indented list", () => {
  expect(links("-         \\@reader &#64;reader @reader")).toEqual([
    ["@reader", "https://github.com/reader", "mention"],
  ]);
});
