import JSZip from "jszip";
import { describe, expect, it } from "vite-plus/test";
import { openEpub } from "./epubPreview";

describe("EPUB SVG component transfer", () => {
  it.each([
    { tag: "feFuncR", type: "table", attributes: ['tableValues="1 0"'] },
    { tag: "feFuncG", type: "discrete", attributes: ['tableValues="0 0.5 1"'] },
    { tag: "feFuncB", type: "gamma", attributes: ['amplitude="2"', 'exponent="3"'] },
  ])("preserves $type parameters", async ({ tag, type, attributes }) => {
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
            <${tag} type="${type}" ${attributes.join(" ")}/>
          </feComponentTransfer></filter>
          <rect width="80" height="80" fill="orange" filter="url(#adjust)"/>
        </svg>`,
      );
    const book = await openEpub(archive);
    const { html } = await book.page(0);
    const transfer = html.match(new RegExp(`<${tag} [^>]*>`))?.[0];
    expect(transfer).toContain(`type="${type}"`);
    for (const attribute of attributes) expect(transfer).toContain(attribute);
  });
});
