import type { Root } from "mdast";
import { describe, expect, it, vi } from "vite-plus/test";

import { parseMarkdownAst } from "./markdownDocument";
import {
  EMPTY_LINK_URLS,
  getCachedMarkdownAst,
  getCachedMarkdownLinkUrls,
  getCachedNativeMarkdown,
} from "./markdownParseCache";

describe("markdownParseCache", () => {
  it("caches repeated AST parses and native transforms for identical markdown strings", () => {
    const parse = vi.fn((): Root => ({ type: "root", children: [] }));
    const first = getCachedMarkdownAst("# Hello world\n`src/a.ts`", parse);
    const second = getCachedMarkdownAst("# Hello world\n`src/a.ts`", parse);
    expect(first).toBe(second);
    expect(parse).toHaveBeenCalledTimes(1);

    const compute = vi.fn((text: string) => `rendered:${text}`);
    expect(getCachedNativeMarkdown("abc", compute)).toBe("rendered:abc");
    expect(getCachedNativeMarkdown("abc", compute)).toBe("rendered:abc");
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("extracts and caches unique link URLs while skipping parsing for link-free prose", () => {
    const parse = vi.fn((input: string): Root => {
      if (input.includes("[ref]")) {
        return {
          type: "root",
          children: [
            {
              type: "paragraph",
              children: [
                { type: "link", url: "src/a.ts", children: [] },
                {
                  type: "linkReference",
                  identifier: "ref",
                  referenceType: "shortcut",
                  children: [],
                },
                { type: "link", url: "src/a.ts", children: [] },
              ],
            },
            { type: "definition", identifier: "ref", url: "https://example.com" },
          ],
        } as unknown as Root;
      }
      return { type: "root", children: [] };
    });

    expect(getCachedMarkdownLinkUrls("Just plain text without links.", parse)).toBe(
      EMPTY_LINK_URLS,
    );
    expect(parse).not.toHaveBeenCalled();

    const doc = "Check [a](<src/a.ts>) and [ref]\n\n[ref]: https://example.com";
    const first = getCachedMarkdownLinkUrls(doc, parse);
    const second = getCachedMarkdownLinkUrls(doc, parse);
    expect(first).toEqual(["src/a.ts", "https://example.com"]);
    expect(second).toBe(first);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("extracts GFM email autolinks with the configured remark-gfm parser", () => {
    const urls = getCachedMarkdownLinkUrls("Contact contact@example.com", parseMarkdownAst);
    expect(urls).toEqual(["mailto:contact@example.com"]);
    expect(getCachedMarkdownLinkUrls("Contact contact@example.com", parseMarkdownAst)).toBe(urls);
    expect(
      getCachedMarkdownLinkUrls("Ping @alice or contact@example.com", parseMarkdownAst),
    ).toEqual(["mailto:contact@example.com"]);
    const parse = vi.fn((): Root => ({ type: "root", children: [] }));
    expect(getCachedMarkdownLinkUrls("a".repeat(20_000), parse)).toBe(EMPTY_LINK_URLS);
    expect(parse).not.toHaveBeenCalled();
  });
});
