import type { Element, Root } from "hast";
import { describe, expect, it } from "vite-plus/test";

import { wordsHast } from "~/markdown/wordsHast";
import {
  pullRequestCommentPreview,
  pullRequestMarkdownExtensions,
} from "./pullRequestMarkdown.logic";

function links(markdown: string) {
  const extensions = pullRequestMarkdownExtensions({
    provider: "github",
    url: "https://github.com/team/repo/pull/8",
  });
  const tree = wordsHast(markdown, {
    math: false,
    breaks: false,
    escapeHtml: false,
    insights: false,
    extensions,
  });
  const found: Array<[string, unknown, unknown]> = [];
  const visit = (node: Root | Element) => {
    for (const child of node.children) {
      if (child.type !== "element") continue;
      if (child.tagName === "a") {
        const label = child.children[0];
        found.push([
          label?.type === "text" ? label.value : "",
          child.properties.href,
          child.properties.dataPullRequestAutolink,
        ]);
      }
      visit(child);
    }
  };
  visit(tree);
  return found;
}

describe("pullRequestMarkdownExtensions", () => {
  it("links the host's references in prose and leaves links and code alone", () => {
    expect(links("Fixes #12 in **abcdef1**. [#13](https://example.com) `#14`")).toEqual([
      ["#12", "https://github.com/team/repo/issues/12", "reference"],
      ["abcdef1", "https://github.com/team/repo/commit/abcdef1", "commit"],
      ["#13", "https://example.com", undefined],
    ]);
  });
  it("renders GitHub emoji shortcodes in prose and leaves code literal", () => {
    const extensions = pullRequestMarkdownExtensions({
      provider: "github",
      url: "https://github.com/team/repo/pull/8",
    });
    const tree = wordsHast("Ship it :tada: :+1: `:tada:`", {
      math: false,
      breaks: false,
      escapeHtml: false,
      insights: false,
      extensions,
    });
    const text = (node: Root | Element | Root["children"][number]): string => {
      if (node.type === "text") return node.value;
      if (node.type === "element" && node.tagName === "code") {
        return `\`${node.children.map(text).join("")}\``;
      }
      return "children" in node ? node.children.map(text).join("") : "";
    };
    expect(text(tree)).toBe("Ship it 🎉 👍 `:tada:`");
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
    ["Approved :thumbsup: `:warning:`", "Approved 👍 :warning:"],
    ["Approved :thumbsup:", "Approved :thumbsup:", "gitlab"],
  ])("extracts readable text from %s", (body, expected, provider = "github") => {
    expect(pullRequestCommentPreview(body, provider)).toBe(expected);
  });
});
