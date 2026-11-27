import JSZip from "jszip";
import { describe, expect, it } from "vite-plus/test";
import { openEpub } from "./epubPreview";

describe("EPUB SVG component transfer", () => {
  it("preserves table, discrete and gamma parameters", async () => {
    const archive = new JSZip()
      .file(
        "META-INF/container.xml",
        '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
      )
      .file(
        "book.opf",
        '<package><manifest><item id="art" href="art.svg" media-type="image/svg+xml"/></manifest><spine><itemref idref="art"/></spine></package>',
      )
      .file(
        "art.svg",
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
          <filter id="adjust"><feComponentTransfer>
            <feFuncR type="table" tableValues="1 0"/>
            <feFuncG type="discrete" tableValues="0 0.5 1"/>
            <feFuncB type="gamma" amplitude="2" exponent="3"/>
          </feComponentTransfer></filter>
          <rect width="80" height="80" fill="orange" filter="url(#adjust)"/>
        </svg>`,
      );
    const book = await openEpub(archive);
    const { html } = await book.page(0);
    expect(html.match(/<feFunc[RGB][^>]*>/g) ?? []).toEqual([
      '<feFuncR type="table" tableValues="1 0">',
      '<feFuncG type="discrete" tableValues="0 0.5 1">',
      '<feFuncB type="gamma" amplitude="2" exponent="3">',
    ]);
  });
});
