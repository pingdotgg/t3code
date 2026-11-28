import { describe, expect, it } from "vite-plus/test";

import { ENRICHED_INLINE_FILE_LINK_REGEX } from "./enrichedLinkPresentation";
import {
  markdownForNativeRendering,
  markdownWithFileEmbeds,
  markdownWithTextDirection,
  parseMarkdownDocument,
} from "./markdownDocument";

const BOM = "\uFEFF";
const render = (markdown: string) =>
  markdownForNativeRendering(markdown, ENRICHED_INLINE_FILE_LINK_REGEX);
const embed = (markdown: string) =>
  markdownWithFileEmbeds(markdown, (href) => (href.endsWith(".pdf") ? "report.pdf" : null))
    .markdown;

describe("a leading byte-order mark", () => {
  it.each([
    ["HTML links", render, 'Hello <a href="https://example.com">world</a>!'],
    ["HTML link labels", render, '<a href="https://example.com">a[b]</a>'],
    ["HTML links after a bang", render, '!<a href="https://example.com">world</a>'],
    ["inline file links", render, "See `src/app.ts` now"],
    ["prose file paths", render, "See /tmp/notes.md"],
    ["table breaks", render, "Intro\n| a | b |\n| - | - |\n| 1 | 2 |"],
    ["Windows path destinations", render, "Open [app](C:\\work\\app.ts) now"],
    ["angled Windows path destinations", render, "Open [app](<C:\\work\\app.ts>) now"],
    ["image paragraphs", render, "Caption\n![shot](https://example.com/a.png)"],
    ["file embeds", embed, "See ![doc](files/report.pdf) now"],
    ["text direction", markdownWithTextDirection, "Hello مرحبا بالعالم كيف حالك\n\nOK مرحبا بكم"],
  ])("leaves %s where they are", (_name, transform, markdown) => {
    expect(transform(markdown)).not.toBe(markdown);
    expect(transform(`${BOM}${markdown}`)).toBe(`${BOM}${transform(markdown)}`);
  });

  it("is kept when the rewrite ends in a second table-break pass", () => {
    const markdown = "Intro text\n| a | c |\n|---|---|\n| `./a\\|b.ts` | b |";
    expect(render(markdown)).toBe(
      "Intro text\n\n| a | c |\n|---|---|\n| [./a|b.ts](<./a|b.ts>) | b |",
    );
    expect(render(`${BOM}${markdown}`)).toBe(`${BOM}${render(markdown)}`);
  });
});

describe("single tildes", () => {
  const prose = "Latency is around 10~20ms (about 80~90% faster), saved under com~apple~CloudDocs.";
  const deletes = (markdown: string) =>
    JSON.stringify(parseMarkdownDocument(markdown)).match(/"type":"delete"/g)?.length ?? 0;
  const unescapedSingleTildes = /(?<![\\~])~(?!~)/;

  it("do not parse as strikethrough", () => {
    expect(deletes(prose)).toBe(0);
    expect(deletes("Real ~~strike~~ here.")).toBe(1);
  });

  it("reach the native renderer escaped, so md4c cannot strike them", () => {
    expect(render(prose)).not.toMatch(unescapedSingleTildes);
    expect(render("Real ~~strike~~ here.")).toContain("~~strike~~");
  });

  it.each(["$a *b~c* d$ x~y", "\\(a *b~c* d\\) x~y", "\\(a \\\\) b~c d\\) x~y"])(
    "stay raw in math, across emphasis and escaped closers: %s",
    (markdown) => {
      expect(render(markdown)).toBe(markdown.replace("x~y", "x\\~y"));
    },
  );
});
