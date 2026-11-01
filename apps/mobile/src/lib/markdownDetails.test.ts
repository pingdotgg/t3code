import { describe, expect, it } from "vite-plus/test";

import { splitMarkdownDetails } from "./markdownDetails";

describe("splitMarkdownDetails", () => {
  // regression: #28059 mobile chat showed every <details> fold open
  it("splits a top-level fold into its summary and hidden body", () => {
    const markdown =
      "Short answer.\n\n<details>\n<summary>Long details</summary>\n\nA long paragraph.\n\n</details>\n\nAfter.";
    expect(splitMarkdownDetails(markdown)).toEqual([
      { kind: "markdown", markdown: "Short answer.\n\n", sourceOffset: 0 },
      {
        kind: "details",
        summary: "Long details",
        body: "\n\nA long paragraph.\n\n",
        open: false,
        sourceOffset: 15,
      },
      { kind: "markdown", markdown: "\n\nAfter.", sourceOffset: 87 },
    ]);
  });

  it("keeps nested folds in the body and honours the open attribute", () => {
    const markdown =
      "<details open>\n<summary>Outer &amp; <code>more</code></summary>\n\n<details>\n<summary>Inner</summary>\n\nx\n\n</details>\n\n</details>";
    const [fold] = splitMarkdownDetails(markdown);
    expect(fold).toMatchObject({ kind: "details", summary: "Outer & more", open: true });
    expect(fold?.kind === "details" && splitMarkdownDetails(fold.body)).toMatchObject([
      { kind: "markdown" },
      { kind: "details", summary: "Inner", body: "\n\nx\n\n" },
      { kind: "markdown" },
    ]);
  });

  it("leaves folds in code and inline tags as markdown", () => {
    for (const markdown of [
      "```html\n<details>\n<summary>Code</summary>\n</details>\n```",
      "Use `<details>` for folds.",
      "Text <details><summary>inline</summary>body</details> more",
      "<!-- <details> -->\n\nVisible answer.",
    ]) {
      expect(splitMarkdownDetails(markdown)).toEqual([
        { kind: "markdown", markdown, sourceOffset: 0 },
      ]);
    }
  });

  it("ignores a closing tag inside a code example in the fold", () => {
    const markdown =
      "<details>\n<summary>Example</summary>\n```html\n</details>\n```\n</details>\n\nAfter.";
    expect(splitMarkdownDetails(markdown)).toMatchObject([
      { kind: "details", summary: "Example", body: "\n```html\n</details>\n```\n" },
      { kind: "markdown", markdown: "\n\nAfter." },
    ]);
  });

  it("closes a fold at a closing tag that ends a paragraph", () => {
    expect(
      splitMarkdownDetails("<details>\n<summary>Plan</summary>\n\nDone </details>\n\nNext step"),
    ).toMatchObject([
      { kind: "details", summary: "Plan", body: "\n\nDone " },
      { kind: "markdown", markdown: "\n\nNext step" },
    ]);
  });

  it("folds the rest of a reply whose closing tag has not streamed yet", () => {
    expect(splitMarkdownDetails("<details>\n<summary>Plan</summary>\n\nStep one")).toEqual([
      { kind: "details", summary: "Plan", body: "\n\nStep one", open: false, sourceOffset: 0 },
    ]);
    expect(
      splitMarkdownDetails("<details>\n<summary>Plan</summary>\n\n```html\n</details>"),
    ).toMatchObject([{ kind: "details", body: "\n\n```html\n</details>" }]);
  });

  it("reads open only as an attribute name", () => {
    expect(
      splitMarkdownDetails('<details title="is open">\n<summary>Plan</summary>\n</details>'),
    ).toMatchObject([{ kind: "details", open: false }]);
  });
});
