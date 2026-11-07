import JSZip from "jszip";
import { describe, expect, it } from "vite-plus/test";

import { prepareOffice } from "./officeArchive";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const V = 'xmlns:v="urn:schemas-microsoft-com:vml"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const relationship = (type: string, target: string) =>
  `<Relationship Id="${type}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const paragraph = (text: string, properties = "") =>
  `<w:p>${properties}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

async function wordFile(
  body: string,
  parts: Partial<Record<"styles" | "numbering" | "header" | "footer" | "footnotes", string>> = {},
  section = "",
) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship("officeDocument", "word/document.xml")}</Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Object.keys(
      parts,
    )
      .map((part) => relationship(part, `${part}.xml`))
      .join("")}</Relationships>`,
  );
  for (const [part, xml] of Object.entries(parts)) zip.file(`word/${part}.xml`, xml);
  zip.file(
    "word/document.xml",
    `<w:document ${W} ${V} ${R}><w:body>${body}<w:sectPr>${section}<w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "arraybuffer" });
}

async function prepared(bytes: ArrayBuffer) {
  const result = await prepareOffice(bytes, "docx");
  const zip = await JSZip.loadAsync(result.bytes);
  return { truncated: result.truncated, part: (path: string) => zip.file(path)?.async("string") };
}

// regression: the budgets sized for a main-thread renderer cut ordinary documents short.
describe("Word preview limits", () => {
  it("keeps a document whose table follows a long one", async () => {
    const rows = Array.from(
      { length: 500 },
      (_, row) =>
        `<w:tr>${Array.from({ length: 5 }, (_, cell) => `<w:tc>${paragraph(`r${row}c${cell}`)}</w:tc>`).join("")}</w:tr>`,
    ).join("");
    const result = await prepared(
      await wordFile(`<w:tbl>${rows}</w:tbl>${paragraph("After the table")}`),
    );
    expect(result.truncated).toBe(false);
    expect(await result.part("word/document.xml")).toContain("After the table");
  });

  it("keeps the list and style definitions of a long document", async () => {
    const levels = Array.from(
      { length: 9 },
      (_, level) =>
        `<w:lvl w:ilvl="${level}"><w:numFmt w:val="decimal"/><w:lvlText w:val="%${level + 1}."/></w:lvl>`,
    ).join("");
    const numbering = `<w:numbering ${W}>${Array.from({ length: 60 }, (_, list) => `<w:abstractNum w:abstractNumId="${list}">${levels}</w:abstractNum>`).join("")}${Array.from({ length: 60 }, (_, list) => `<w:num w:numId="${list + 1}"><w:abstractNumId w:val="${list}"/></w:num>`).join("")}</w:numbering>`;
    const styles = `<w:styles ${W}>${Array.from(
      { length: 1_500 },
      (_, style) =>
        `<w:style w:type="paragraph" w:styleId="S${style}">${style % 10 ? `<w:basedOn w:val="S${style - 1}"/>` : ""}<w:pPr><w:spacing w:after="${style}"/></w:pPr><w:rPr><w:sz w:val="22"/></w:rPr></w:style>`,
    ).join("")}</w:styles>`;
    const result = await prepared(
      await wordFile(
        Array.from({ length: 6_000 }, (_, index) =>
          paragraph(
            `Item ${index}`,
            `<w:pPr><w:pStyle w:val="S${index % 1_500}"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${(index % 60) + 1}"/></w:numPr></w:pPr>`,
          ),
        ).join(""),
        { styles, numbering },
      ),
    );
    expect(result.truncated).toBe(false);
    expect(await result.part("word/numbering.xml")).toBe(numbering);
    expect(await result.part("word/styles.xml")).toBe(styles);
    expect(await result.part("word/document.xml")).toContain("Item 5999");
  });

  const text = "x".repeat(40_000);
  it.each([
    ["on its own", `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`],
    [
      "after an empty paragraph in a text box",
      `<w:p><w:r><w:pict><v:shape><v:textbox><w:txbxContent><w:p/></w:txbxContent></v:textbox></v:shape></w:pict></w:r><w:r><w:t>${text}</w:t></w:r></w:p>`,
    ],
    ["written as CDATA", `<w:p><w:r><w:t><![CDATA[${text}]]></w:t></w:r></w:p>`],
  ])("stops before a paragraph too long to lay out %s", async (_, long) => {
    const result = await prepared(
      await wordFile(paragraph("Kept") + long + paragraph("Not reached")),
    );
    expect(result.truncated).toBe(true);
    const document = await result.part("word/document.xml");
    expect(document).toContain("Kept");
    expect(document).not.toContain("Not reached");
  });

  it("counts only the text a paragraph lays out", async () => {
    const formatted = `<w:p>${" ".repeat(40_000)}<w:r><w:instrText>${"x".repeat(40_000)}</w:instrText></w:r><w:r><w:t>Short</w:t></w:r></w:p>`;
    const result = await prepared(await wordFile(formatted + paragraph("After")));
    expect(result.truncated).toBe(false);
    expect(await result.part("word/document.xml")).toContain("After");
  });

  it.each([
    ["used", true],
    ["unused", false],
  ])("leaves out only a header too long to lay out (%s)", async (_, used) => {
    const header = `<w:hdr ${W}>${Array.from({ length: 3_000 }, (_, line) => paragraph(`Header line ${line}`)).join("")}</w:hdr>`;
    const footer = `<w:ftr ${W}>${paragraph("Footer")}</w:ftr>`;
    const footnotes = `<w:footnotes ${W}><w:footnote w:id="1">${paragraph("Note")}</w:footnote></w:footnotes>`;
    const result = await prepared(
      await wordFile(
        `<w:p><w:r><w:t>Body</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>`,
        { header, footer, footnotes },
        `${used ? '<w:headerReference w:type="default" r:id="header"/>' : ""}<w:footerReference w:type="default" r:id="footer"/>`,
      ),
    );
    expect(result.truncated).toBe(used);
    expect(await result.part("word/header.xml")).toBeUndefined();
    expect(await result.part("word/footer.xml")).toBe(footer);
    expect(await result.part("word/footnotes.xml")).toBe(footnotes);
    expect(await result.part("word/document.xml")).toContain("Body");
  });
});
