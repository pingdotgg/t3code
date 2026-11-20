import { describe, expect, it } from "vite-plus/test";

import { splitMarkdownDetails } from "./markdownDetails";
import {
  markdownForNativeParsing,
  markdownReferenceDefinitions,
  withReferenceDefinitions,
} from "./markdownDocument";
import { parseMarkdown } from "react-native-enriched-markdown/src/web/parseMarkdown";

type NativeNode = Awaited<ReturnType<typeof parseMarkdown>>;

/** Where the native parser sends each link and image in one rendered fragment of a reply. */
async function referenceDestinations(reply: string, pick: number) {
  const segment = splitMarkdownDetails(reply)[pick];
  const fragment = segment?.kind === "details" ? segment.body : (segment?.markdown ?? "");
  const urls: Array<string | undefined> = [];
  const visit = (node: NativeNode) => {
    if (node.type === "Link" || node.type === "Image") urls.push(node.attributes?.url);
    node.children?.forEach(visit);
  };
  visit(
    await parseMarkdown(
      markdownForNativeParsing(
        withReferenceDefinitions(fragment, markdownReferenceDefinitions(reply)),
      ),
    ),
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
});

describe("withReferenceDefinitions", () => {
  it("resolves a fragment's references from the whole reply, its own definitions first", async () => {
    const fold = "\n\n<details><summary>A</summary>a</details>\n\n";
    for (const [reply, pick, expected] of [
      // Into a fold, with an escaped label and a Windows destination kept as written.
      [
        "<details>\n<summary>A</summary>\n\n[config][c] ![B][a\\]b]\n\n</details>\n\n[c]: C:\\work\\.t3\\settings.json\n[a\\]b]: https://example.com/a",
        0,
        ["C:\\work\\.t3\\settings.json", "https://example.com/a"],
      ],
      // Out of a fold.
      [
        "See [d].\n\n<details>\n<summary>A</summary>\n\n[d]: https://example.com\n\n</details>",
        0,
        ["https://example.com"],
      ],
      // A quoted definition that wraps onto continuation lines.
      [`See [d].${fold}> [d]:\n> https://example.com\n> "Title"`, 0, ["https://example.com"]],
      // A definition the compact HTML block hides from the reply's parse, with a label that wraps.
      [
        "See [the\n  doc].\n\n<details><summary>A</summary>a</details>\n[The Doc]: https://example.com",
        0,
        ["https://example.com"],
      ],
      // A literal ">" in a wrapped label is part of the label, not a quote marker.
      [
        `[part rest] and [part > rest]${fold}[part\n    > rest]: https://example.com/a\n\n[part rest]: https://example.com/b`,
        0,
        ["https://example.com/b", "https://example.com/a"],
      ],
      // A fragment's own definition wins, however the parser equates the two labels.
      [
        "[ x ]: https://outside.example\n\n<details>\n<summary>S</summary>\n\nSee [x].\n\n[X]: https://inside.example\n\n</details>",
        1,
        ["https://inside.example"],
      ],
      [
        "[SS]: https://outside.example\n\n<details>\n<summary>S</summary>\n\nSee [SS].\n\n[\u00df]: https://inside.example\n\n</details>",
        1,
        ["https://inside.example"],
      ],
    ] as const) {
      expect(await referenceDestinations(reply, pick)).toEqual(expected);
    }
  });

  it("leaves a fragment with nothing to resolve as written", () => {
    expect(withReferenceDefinitions("See [d].", [])).toBe("See [d].");
    expect(withReferenceDefinitions("Plain text.", ["[d]: https://example.com"])).toBe(
      "Plain text.",
    );
  });
});
