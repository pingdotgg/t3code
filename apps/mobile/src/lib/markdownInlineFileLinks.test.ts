import { describe, expect, it } from "vite-plus/test";
import { ENRICHED_INLINE_FILE_LINK_REGEX } from "./enrichedLinkPresentation";
import { markdownWithInlineFileLinks, parseMarkdownDocument } from "./markdownDocument";

const rewrite = (markdown: string) =>
  markdownWithInlineFileLinks(markdown, ENRICHED_INLINE_FILE_LINK_REGEX);

describe("inline code that names a file", () => {
  it("becomes a link to the same path", () => {
    expect(rewrite("See `src/math.ts:2` and `./README.md`.")).toBe(
      "See [src/math.ts:2](<src/math.ts:2>) and [./README.md](<./README.md>).",
    );
  });

  it("keeps commands, identifiers and URLs as code", () => {
    const markdown = "Run `vp test run`, call `useMemo`, open `https://example.com/a.ts`.";
    expect(rewrite(markdown)).toBe(markdown);
  });

  it("leaves fenced code blocks and code already inside a link alone", () => {
    const markdown = "```\nsrc/math.ts:2\n```\n\n[`src/math.ts`](src/math.ts)";
    expect(rewrite(markdown)).toBe(markdown);
  });

  it("links to the exact path when it holds backslashes or ampersands", () => {
    for (const path of ["C:\\repo\\_private\\file.ts", "./src/a&copy;.ts", "./src/[id].ts"]) {
      const paragraph = parseMarkdownDocument(rewrite(`\`${path}\``)).children[0];
      const link = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
      expect(link?.type === "link" && link.url).toBe(path);
      expect(
        link?.type === "link" && link.children[0]?.type === "text" && link.children[0].value,
      ).toBe(path);
    }
  });
});
