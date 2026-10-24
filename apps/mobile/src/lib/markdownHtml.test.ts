import { describe, expect, it } from "vite-plus/test";
import { markdownHtmlContent, markdownWithHtml, parseMarkdownDocument } from "./markdownDocument";
import { markdownImageSources } from "./markdownImageSources";

describe("HTML in native Markdown", () => {
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
    ).toBe("[![Review](<https://example.com/banner.svg>)](<https://example.com>)");
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

  it("links HTML anchors in a table cell without breaking the row at <br>", () => {
    const document = parseMarkdownDocument(
      "| Status | Preview URL |\n| - | - |\n| Done | <a href='https://commit.example.com'>Commit</a><br><a href='https://branch.example.com'>Branch</a> |",
    );
    const table = document.children[0];
    expect(table?.type).toBe("table");
    if (table?.type !== "table") return;
    expect(table.children).toHaveLength(2);
    expect(table.children[1]?.children[1]?.children).toMatchObject([
      { type: "link", url: "https://commit.example.com", children: [{ value: "Commit" }] },
      { type: "text", value: " " },
      { type: "link", url: "https://branch.example.com", children: [{ value: "Branch" }] },
    ]);
  });

  it("keeps a table row intact when an anchor href contains a pipe", () => {
    const document = parseMarkdownDocument(
      "| Preview | Logs |\n| - | - |\n| <a href='https://example.com/?a=1&#124;2'>Open</a> | done |",
    );
    const table = document.children[0];
    expect(table?.type).toBe("table");
    if (table?.type !== "table") return;
    expect(table.children[1]?.children).toMatchObject([
      { children: [{ type: "link", url: "https://example.com/?a=1%7C2" }] },
      { children: [{ value: "done" }] },
    ]);
  });

  it("keeps anchor text unlinked for unsafe hrefs", () => {
    expect(markdownWithHtml('Run <a href="javascript:alert(1)">this</a> now')).toBe("Run this now");
  });
});
