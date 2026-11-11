import { describe, expect, it } from "vite-plus/test";

import { splitMarkdownDetails } from "./markdownDetails";
import {
  markdownReferenceDefinitions,
  parseMarkdownDocument,
  withReferenceDefinitions,
  type MarkdownNode,
} from "./markdownDocument";

/** Where each label in a fragment resolves once it carries the reply's definitions; first wins. */
function destinations(reply: string, fragment: string): Record<string, string> {
  const urls: Record<string, string> = {};
  const visit = (node: MarkdownNode) => {
    if (node.type === "definition") urls[node.identifier] ??= node.url;
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(
    parseMarkdownDocument(withReferenceDefinitions(fragment, markdownReferenceDefinitions(reply))),
  );
  return urls;
}

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

  it("resolves references the way the whole reply does", () => {
    const fold = "\n\n<details><summary>A</summary>a</details>\n\n";
    for (const [markdown, pick, expected] of [
      // A quoted definition that wraps onto continuation lines.
      [`See [d].${fold}> [d]:\n> https://example.com\n> "Title"`, 0, { d: "https://example.com" }],
      // A definition hidden in a compact HTML block, with a label that wraps.
      [
        "See [the\n  doc].\n\n<details><summary>A</summary>a</details>\n[The Doc]: https://example.com",
        0,
        { "the doc": "https://example.com" },
      ],
      // A literal ">" in a wrapped label is part of the label, not a quote marker.
      [
        `[part rest] and [part > rest]${fold}[part\n    > rest]: https://example.com/a\n\n[part rest]: https://example.com/b`,
        0,
        { "part > rest": "https://example.com/a", "part rest": "https://example.com/b" },
      ],
      // A fold that defines a label keeps its own definition, however the label is spaced.
      [
        "[ x ]: https://outside.example\n\n<details>\n<summary>S</summary>\n\nSee [ x ].\n\n[x]: https://inside.example\n\n</details>",
        1,
        { x: "https://inside.example" },
      ],
    ] as const) {
      const segment = splitMarkdownDetails(markdown)[pick];
      const fragment = segment?.kind === "details" ? segment.body : (segment?.markdown ?? "");
      expect(destinations(markdown, fragment)).toEqual(expected);
    }
  });
});
