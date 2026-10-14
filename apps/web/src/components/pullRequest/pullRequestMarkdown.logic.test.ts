import { describe, expect, it } from "vite-plus/test";

import { pullRequestMarkdownPreview } from "./pullRequestMarkdown.logic";

describe("resolved mention previews", () => {
  it.each(["```\n[!NOTE]\n```", "    [!NOTE]", "`[!NOTE]`"])(
    "preserves literal alert markers in code: %s",
    (body) => expect(pullRequestMarkdownPreview(body)).toBe("[!NOTE]"),
  );
  it.each(["<br>", "<br/>", "<BR />", '<br title="break">', '<br title="a > b">'])(
    "separates words across HTML breaks: %s",
    (tag) => expect(pullRequestMarkdownPreview(`Review:${tag}@Alex`)).toBe("Review: @Alex"),
  );
  it("hides alert markers just like unresolved comment previews", () => {
    expect(pullRequestMarkdownPreview("> [!NOTE]\n> @Alex Smith done")).toBe("@Alex Smith done");
  });
  it.each(["@Alex  \nplease review", "@Alex\\\nplease review"])(
    "separates words across hard breaks in %s",
    (body) => expect(pullRequestMarkdownPreview(body)).toBe("@Alex please review"),
  );
  it("preserves literal Markdown characters in names", () => {
    expect(pullRequestMarkdownPreview("@Jane\\_Smith @A\\[B\\]\\*\\`\\\\")).toBe(
      "@Jane_Smith @A[B]*`\\",
    );
  });

  it("separates blocks and keeps links and code readable", () => {
    expect(
      pullRequestMarkdownPreview(
        "First paragraph\n\n- [Alex](https://example.com)\n- `@{literal}`\n\n<!-- hidden -->\nLast paragraph",
      ),
    ).toBe("First paragraph Alex @{literal} Last paragraph");
  });
});
