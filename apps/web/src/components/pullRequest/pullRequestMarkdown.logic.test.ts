import { changeRequestReferenceAutolinker } from "@t3tools/client-runtime/pull-request-markdown";
import remarkParse from "remark-parse";
import { unified, type PluggableList } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { SourceControlProviderKind } from "@t3tools/contracts";

import {
  issueMarkdownPlugins,
  projectReferenceMarkdownPlugins,
  pullRequestCommentPreview,
  remarkPullRequestAutolinks,
} from "./pullRequestMarkdown.logic";

type Node = {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  data?: { hProperties?: Record<string, unknown> };
  children?: Node[];
};

function links(
  markdown: string,
  plugins: PluggableList = [
    [
      remarkPullRequestAutolinks,
      {
        autolinks: changeRequestReferenceAutolinker({
          provider: "github",
          url: "https://github.com/team/repo/pull/8",
        })!,
      },
    ],
  ],
) {
  const processor = unified().use(remarkParse).use(plugins);
  const tree = processor.runSync(processor.parse(markdown)) as Node;
  const found: Array<[string | undefined, string | undefined, unknown]> = [];
  const visit = (node: Node) => {
    if (node.type === "link" || node.type === "image") {
      found.push([
        node.alt ?? node.children?.[0]?.value,
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

  it("links an issue body's references to the issue's repository, and nothing else", () => {
    const plugins = issueMarkdownPlugins({
      tracker: "gitlab",
      url: "http://gitlab.internal:8080/team/app/-/issues/8",
      scope: "team/app",
    });
    expect(links("See #12, !14, other#13, @alice and ![shot](/uploads/a.png).", plugins)).toEqual([
      ["#12", "http://gitlab.internal:8080/team/app/-/issues/12", "reference"],
      ["shot", "/uploads/a.png", undefined],
    ]);
    expect(
      links(
        "See #12.",
        issueMarkdownPlugins({
          tracker: "gitlab",
          url: "http://gitlab.internal:8080/gitlab/team/app/-/issues/8",
          scope: "team/app",
        }),
      ),
    ).toEqual([["#12", "http://gitlab.internal:8080/gitlab/team/app/-/issues/12", "reference"]]);
  });

  it("links only `#123` in a thread's words to its project's repository", () => {
    const plugins = projectReferenceMarkdownPlugins({
      canonicalKey: "github.com/team/repo",
      provider: SourceControlProviderKind.make("github"),
      displayName: "team/repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "git@github.com:team/repo",
      },
    });
    expect(links("Fixes #12 and PR#13 in abcdef1 for @scope/pkg.", plugins)).toEqual([
      ["#12", "https://github.com/team/repo/issues/12", "reference"],
    ]);
    expect(projectReferenceMarkdownPlugins(null)).toEqual([]);
    expect(
      projectReferenceMarkdownPlugins({
        canonicalKey: "gitlab.%zz/team/repo",
        provider: SourceControlProviderKind.make("gitlab"),
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "git@gitlab.%zz:team/repo",
        },
      }),
    ).toEqual([]);
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
