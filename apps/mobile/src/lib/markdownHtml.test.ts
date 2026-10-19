import { describe, expect, it } from "vite-plus/test";
import { markdownHtmlContent, markdownWithHtml, parseMarkdownDocument } from "./markdownDocument";
import { markdownImageSources } from "./markdownImageSources";

describe("HTML in native Markdown", () => {
  it("leaves code inside an HTML details block literal", () => {
    const content =
      '<details>\n<summary>Example</summary>\n\n```html\n<img src="literal.png">\n```\n\nUse `<img>` here.\n</details>';
    const result = markdownHtmlContent(content);
    expect(result).toContain('```html\n<img src="literal.png">\n```');
    expect(result).toContain("Use `<img>` here.");
    expect(result).not.toContain("<details>");
  });
  it("preserves screenshot URLs and captions from GitHub HTML image embeds", () => {
    expect(
      markdownHtmlContent(
        '<img width="900" alt="Before > after [settings]" src="https://example.com/before.png?a=1&amp;b=2" />',
      ),
    ).toBe("![Before > after \\[settings\\]](<https://example.com/before.png?a=1\\&b=2>)");
    expect(
      markdownHtmlContent(
        "<a href='https://example.com'><img src='https://example.com/banner.svg' alt='Review' /></a>",
      ),
    ).toBe("![Review](<https://example.com/banner.svg>)");
  });

  it("decodes HTML attributes once and preserves entity-shaped query values through Markdown", () => {
    const markdown =
      '<img alt="&amp;lt;" src="https://example.com/shot.png?label=&amp;lt;&amp;sig=a%26b">';
    expect(markdownWithHtml(markdown)).toBe(
      "![\\&lt;](<https://example.com/shot.png?label=\\&lt;\\&sig=a%26b>)",
    );
    expect(markdownImageSources(markdown)).toEqual([
      "https://example.com/shot.png?label=&lt;&sig=a%26b",
    ]);
    const paragraph = parseMarkdownDocument(markdown).children[0];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type === "paragraph")
      expect(paragraph.children[0]).toMatchObject({ type: "image", alt: "&lt;" });
  });

  it("ignores code delimiters in HTML attributes and comments when collecting screenshots", () => {
    const markdown =
      '<details data-example="`">\n<summary>Proof</summary>\n<img src="https://example.com/shot.png" alt="Screenshot">\n<!-- ` -->\n</details>';
    expect(markdownHtmlContent(markdown)).toContain(
      "![Screenshot](<https://example.com/shot.png>)",
    );
    expect(markdownImageSources(markdown)).toEqual(["https://example.com/shot.png"]);
    expect(markdownWithHtml(markdown)).not.toContain("<img");
  });

  it("removes bot metadata and details wrappers while keeping the content", () => {
    const markdown =
      "<!-- generated bot metadata -->\n<details>\n<summary>Walkthrough</summary>\n\n## Changes\n\nText\n\n</details>";
    const result = markdownWithHtml(markdown);
    expect(result).not.toContain("<!--");
    expect(result).not.toContain("<details>");
    expect(result).toContain("**Walkthrough**");
    expect(result).toContain("## Changes");
    expect(parseMarkdownDocument(markdown).children.some((node) => node.type === "html")).toBe(
      false,
    );
  });

  it("collects HTML and Markdown screenshots while leaving inline and fenced code literal", () => {
    const markdown =
      '```html\n<img src="literal.png">\n```\n\nUse `<img src="inline.png">` here.\n\n<img src="one.png">\n\n![Two](two.png)\n\n<img src="one.png">';
    expect(markdownImageSources(markdown)).toEqual(["one.png", "two.png"]);
    const result = markdownWithHtml(markdown);
    expect(result).toContain('```html\n<img src="literal.png">\n```');
    expect(result).toContain('`<img src="inline.png">`');
  });
});

describe("Windows drive paths in mobile Markdown documents", () => {
  it("keeps backslashes before punctuation in prose paths", () => {
    const markdown = String.raw`Saved to C:\Users\me\.t3\_build\shot.png and C:/work\.config and C:\folder\(draft.`;

    expect(parseMarkdownDocument(markdown).children).toMatchObject([
      { type: "paragraph", children: [{ type: "text", value: markdown }] },
    ]);
  });

  it("keeps ordinary Markdown escapes and inline and fenced code unchanged around drive paths", () => {
    const code = String.raw`C:\Users\me\.t3\_build\shot.png \*literal\*`;
    const markdown = [
      String.raw`See C:\x and \*this\* and Note:\*that\*. Code: ` + "`" + code + "`",
      "",
      "```text",
      code,
      "```",
    ].join("\n");

    expect(parseMarkdownDocument(markdown).children).toMatchObject([
      {
        type: "paragraph",
        children: [
          { type: "text", value: String.raw`See C:\x and *this* and Note:*that*. Code: ` },
          { type: "inlineCode", value: code },
        ],
      },
      { type: "code", lang: "text", value: code },
    ]);

    const links = String.raw`[file](C:\dir\.config "C:\dir\_title") and ![image](C:\dir\.png)

[file]: C:\dir\.config`;
    expect(parseMarkdownDocument(links).children).toMatchObject([
      {
        type: "paragraph",
        children: [
          { type: "link", url: String.raw`C:\dir\.config`, title: String.raw`C:\dir\_title` },
          { type: "text", value: " and " },
          { type: "image", url: String.raw`C:\dir\.png` },
        ],
      },
      { type: "definition", identifier: "file", url: String.raw`C:\dir\.config` },
    ]);
    for (const suffix of ["", "[]"]) {
      const references =
        String.raw`[C:\a\.b]` + suffix + "\n\n" + String.raw`[C:\a\.b]: https://x.test`;
      const [paragraph, definition] = parseMarkdownDocument(references).children;
      expect(paragraph).toMatchObject({ type: "paragraph", children: [{ type: "linkReference" }] });
      expect(definition).toMatchObject({ type: "definition", url: "https://x.test" });
      if (paragraph?.type === "paragraph" && definition?.type === "definition")
        expect(paragraph.children[0]).toMatchObject({ identifier: definition.identifier });
    }
  });
});
