import { describe, expect, it } from "vite-plus/test";
import {
  markdownForNativeRendering,
  markdownHtmlContent,
  markdownWithHtml,
  markdownWithFileEmbeds,
  parseMarkdownDocument,
  type MarkdownNode,
} from "./markdownDocument";
import { markdownImageSources } from "./markdownImageSources";
import { markdownFileEmbedLabel, resolveMarkdownMediaPreview } from "./markdownMedia";
import { resolveMarkdownLinkPresentation } from "./markdownLinks";
import { ENRICHED_INLINE_FILE_LINK_REGEX } from "./enrichedLinkPresentation";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { parseMarkdown } from "react-native-enriched-markdown/src/web/parseMarkdown";

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

  it("treats an unclosed fence in an HTML block as code through the end", () => {
    // Sized so the quadratic rescan cannot finish within the test timeout.
    const fences = Array.from({ length: 40_000 }, () => "```x y").join("\n");
    const markdown = `<details>\n<img src="before.png">\n${fences}\n<img src="after.png">\n</details>`;
    const result = markdownHtmlContent(markdown);
    expect(result).toContain("![](<before.png>)");
    expect(result).not.toContain("<details>");
    expect(result).toContain('<img src="after.png">\n</details>');
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

describe("file embeds in native thread and file Markdown", () => {
  const input = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    workspaceRoot: "/repo",
  };
  const assets = (markdown: string) => {
    const result: MarkdownNode[] = [];
    const visit = (node: MarkdownNode) => {
      if (node.type === "link" || node.type === "image") result.push(node);
      if ("children" in node) node.children.forEach(visit);
    };
    visit(parseMarkdownDocument(markdown));
    return result;
  };

  it.each([
    [
      "[![sheet](./report.csv)](https://example.com/download)",
      "report.csv",
      "https://example.com/download",
    ],
    ["[![report](./report.pdf)](./report.pdf)", "report.pdf", "./report.pdf"],
    [
      "[![sheet][f]][download]\n\n[f]: ./report.csv\n[download]: https://example.com/download",
      "report.csv",
      "https://example.com/download",
    ],
  ])("keeps the enclosing link for %s", async (source, filename, target) => {
    const converted = markdownWithFileEmbeds(source, (href, standalone) =>
      markdownFileEmbedLabel(href, input, standalone),
    );
    expect((await parseMarkdown(converted.markdown)).children).toMatchObject([
      {
        type: "Paragraph",
        children: [
          {
            type: "Link",
            attributes: { url: target },
            children: [{ type: "Text", content: filename }],
          },
        ],
      },
    ]);
  });

  it.each(["f", "F", "File Label", "file   label"])(
    "uses the first reference definition for %s",
    async (identifier) => {
      const source = `![sheet][${identifier}]\n\n[${identifier.toLowerCase()}]: ./report.csv\n[${identifier.toUpperCase()}]: ./report.xlsx`;
      const converted = markdownWithFileEmbeds(source, (href, standalone) =>
        markdownFileEmbedLabel(href, input, standalone),
      );
      expect(converted.fileHrefs).toEqual(new Set(["./report.csv"]));
      expect((await parseMarkdown(converted.markdown)).children).toMatchObject([
        {
          type: "Paragraph",
          children: [
            {
              type: "Link",
              attributes: { url: "./report.csv" },
              children: [{ type: "Text", content: "report.csv" }],
            },
          ],
        },
      ]);
      expect((await parseMarkdown(source)).children).toMatchObject([
        { type: "Paragraph", children: [{ type: "Image", attributes: { url: "./report.csv" } }] },
      ]);
    },
  );

  it.each([
    "report.csv",
    "report.tsv",
    "report.pdf",
    "report.docx",
    "report.xlsx",
    "report.pptx",
    "report.unknown",
    "main.tf",
    "schema.prisma",
    "index.astro",
    "main.zig",
    "Containerfile",
    "sound.mp3",
    "clip.mp4",
  ])("uses filename links throughout prose, lists, and tables for %s", (name) => {
    for (const href of [
      `./${name}`,
      `/tmp/${name}`,
      `file:///tmp/${name}`,
      `https://cdn.example.com/${name}?signature=a%2fb`,
    ]) {
      if (name === "Containerfile" && href.startsWith("https:")) continue;
      for (const source of [
        `download: ![sheet](<${href}>)`,
        `- ![sheet](<${href}>)`,
        `| file |\n| --- |\n| ![sheet](<${href}>) |`,
        `download: ![sheet][file]\n\n[file]: <${href}>`,
        `download: <img src="${href}" alt="sheet">`,
      ]) {
        const converted = markdownWithFileEmbeds(markdownWithHtml(source), (url, standalone) =>
          markdownFileEmbedLabel(url, input, standalone),
        );
        const image = href.startsWith("https:") && /\.(unknown|tf|prisma|astro|zig)$/.test(name);
        if (image) expect(converted.markdown).toBe(markdownWithHtml(source));
        else
          expect(assets(converted.markdown)).toMatchObject([
            { type: "link", url: href, children: [{ type: "text", value: name }] },
          ]);
        expect(converted.fileHrefs.has(href)).toBe(!image);
        const preview = resolveMarkdownMediaPreview(href, { ...input, imageEmbed: true });
        if (
          !href.startsWith("https:") &&
          !name.endsWith(".pdf") &&
          !name.endsWith(".mp3") &&
          !name.endsWith(".mp4")
        ) {
          expect(preview?.kind).toBe("file");
          expect(resolveMarkdownLinkPresentation(href)).toMatchObject({ kind: "file" });
        }
      }
    }
  });

  it("retains standalone audio players and image/video embeds in threads", () => {
    const source =
      "![sound](./sound.mp3)\n\n![image](./image.png)\n\n![clip](./clip.mp4)\n\ninline ![photo](./photo.png)";
    const converted = markdownWithFileEmbeds(source, (href, standalone) =>
      markdownFileEmbedLabel(href, input, standalone),
    );
    expect(converted.markdown).toBe(source);
    expect(converted.fileHrefs.size).toBe(0);
    expect(resolveMarkdownMediaPreview("./sound.mp3", input)?.kind).toBe("audio");
  });

  it("uses audio filenames in file previews and draft workspaces", () => {
    const draft = { ...input, threadId: undefined, workspaceRoot: "/repo/docs" };
    const converted = markdownWithFileEmbeds("![sound](./sound.mp3)", (href) =>
      markdownFileEmbedLabel(href, draft, false),
    );
    expect(assets(converted.markdown)).toMatchObject([
      { type: "link", url: "./sound.mp3", children: [{ value: "sound.mp3" }] },
    ]);
    expect(resolveMarkdownMediaPreview("./sound.mp3", draft)?.source).toMatchObject({
      resource: { _tag: "draft-workspace-file", cwd: "/repo/docs", path: "/repo/docs/./sound.mp3" },
    });
  });

  it("keeps captured images on the image path and documents on filename links", () => {
    const captured = { ...input, captured: true };
    const converted = markdownWithFileEmbeds(
      "![photo](./photo.png)\n\n![clip](./clip.mp4)\n\n![sheet](./report.csv)",
      (href, standalone) => markdownFileEmbedLabel(href, captured, standalone),
    );
    expect(assets(converted.markdown)).toMatchObject([
      { type: "image", url: "./photo.png" },
      { type: "image", url: "./clip.mp4" },
      { type: "link", url: "./report.csv", children: [{ value: "report.csv" }] },
    ]);
    expect(resolveMarkdownMediaPreview("./report.csv", captured)).toBeNull();
  });

  it("preserves table structure and filename punctuation", () => {
    const source = "| file |\n| --- |\n| ![sheet](./report%5B1%5D%26%7C.csv) |";
    const converted = markdownWithFileEmbeds(source, (href, standalone) =>
      markdownFileEmbedLabel(href, input, standalone),
    );
    expect(parseMarkdownDocument(converted.markdown).children[0]?.type).toBe("table");
    expect(assets(converted.markdown)).toMatchObject([
      { type: "link", url: "./report%5B1%5D%26%7C.csv", children: [{ value: "report[1]&|.csv" }] },
    ]);
  });

  it("keeps authored positions, signed URLs, and code examples literal", () => {
    const href = "https://cdn.example.com/report%23one%2520.csv?name=&lt;&signature=a%2fb";
    const source = `![report](<${href.replaceAll("&", "\\&")}>)\n\n![source](./main.tf#L42C3)\n\n\`![sheet](./literal.csv)\`\n\n\`\`\`md\n![sheet](./fenced.csv)\n\`\`\``;
    const converted = markdownWithFileEmbeds(source, (url, standalone) =>
      markdownFileEmbedLabel(url, input, standalone),
    );
    expect(assets(converted.markdown)).toMatchObject([
      { type: "link", url: href, children: [{ value: "report#one%20.csv" }] },
      { type: "link", url: "./main.tf#L42C3", children: [{ value: "main.tf · L42:C3" }] },
    ]);
    expect(converted.markdown).toContain("`![sheet](./literal.csv)`");
    expect(converted.markdown).toContain("```md\n![sheet](./fenced.csv)\n```");
    expect(converted.fileHrefs.has(href)).toBe(true);
  });
});

describe("Windows paths in native Markdown", () => {
  // regression: #23722 Markdown escapes ate the separator before `.t3` and `_build`
  it("keeps backslashes in Windows image and link destinations", async () => {
    const image = String.raw`C:\work\.t3\_build\shot.png`;
    const link = String.raw`\\server\share\.t3\notes.md`;
    const markdown = [
      `![shot](${image} "Shot")`,
      String.raw`![paren](C:\a\)b.png)`,
      `[notes](<${link}>)`,
      `<img src="${image}">`,
      String.raw`![amp](C:\R&D\.t3\a&amp;b.png)`,
      String.raw`<img src="C:\R&amp;D\.t3\b.png">`,
      "> ![quoted](\n> " + image + ")",
    ].join("\n\n");

    const native = await parseMarkdown(
      markdownForNativeRendering(markdown, ENRICHED_INLINE_FILE_LINK_REGEX),
    );
    const urls: string[] = [];
    const collect = (node: { attributes?: { url?: string }; children?: unknown[] }) => {
      if (node.attributes?.url) urls.push(node.attributes.url);
      node.children?.forEach((child) => collect(child as typeof node));
    };
    collect(native);
    const paren = String.raw`C:\a\)b.png`;
    const amp = String.raw`C:\R&D\.t3\a&b.png`;
    const htmlAmp = String.raw`C:\R&D\.t3\b.png`;
    expect(urls).toEqual([image, paren, link, image, amp, htmlAmp, image]);
    expect(markdownImageSources(markdown)).toEqual([image, paren, amp, htmlAmp]);
  });
});

it("keeps backslashes in drive paths in mobile Markdown prose", () => {
  const path = String.raw`Saved to C:\Users\me\.t3\_build\shot.png and C:/work\.config.`;

  expect(parseMarkdownDocument(String.raw`${path} Then \*this\*.`).children).toMatchObject([
    { type: "paragraph", children: [{ type: "text", value: `${path} Then *this*.` }] },
  ]);
});
