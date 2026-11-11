import { describe, expect, it } from "vite-plus/test";

import { splitMarkdownDetails } from "./markdownDetails";
import { markdownReferenceDefinitions, withReferenceDefinitions } from "./markdownDocument";

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

  it("gives each fragment the reference definitions it mentions, as written", () => {
    const markdown =
      "See [config][c] and [Docs][a\\]b].\n\n<details>\n<summary>A</summary>\n\n![B][a\\]b]\n\n</details>\n\nUnrelated.\n\n[c]: C:\\work\\settings.json\n> [a\\]b]: https://example.com/a";
    const definitions = markdownReferenceDefinitions(markdown);
    const [before, fold, after] = splitMarkdownDetails(markdown);
    expect(
      before?.kind === "markdown" && withReferenceDefinitions(before.markdown, definitions),
    ).toBe(
      "[c]: C:\\work\\settings.json\n[a\\]b]: https://example.com/a\n\nSee [config][c] and [Docs][a\\]b].\n\n",
    );
    expect(fold?.kind === "details" && withReferenceDefinitions(fold.body, definitions)).toBe(
      "[a\\]b]: https://example.com/a\n\n\n\n![B][a\\]b]\n\n",
    );
    // The fragment holding the definitions mentions them and keeps them unduplicated.
    expect(
      after?.kind === "markdown" && withReferenceDefinitions(after.markdown, definitions),
    ).toBe("\n\nUnrelated.\n\n[c]: C:\\work\\settings.json\n> [a\\]b]: https://example.com/a");
  });

  it("finds definitions that wrap, sit in quotes, or hide in a compact HTML block", () => {
    for (const [markdown, definition] of [
      [
        'See [d].\n\n<details><summary>A</summary>a</details>\n\n> [d]:\n> https://example.com\n> "Title"',
        '[d]: https://example.com "Title"',
      ],
      [
        "See [the\n  doc].\n\n<details><summary>A</summary>a</details>\n[The Doc]: https://example.com",
        "[The Doc]: https://example.com",
      ],
    ] as const) {
      const [before] = splitMarkdownDetails(markdown);
      const text = before?.kind === "markdown" ? before.markdown : "";
      expect(withReferenceDefinitions(text, markdownReferenceDefinitions(markdown))).toBe(
        `${definition}\n\n${text}`,
      );
    }
  });
});
