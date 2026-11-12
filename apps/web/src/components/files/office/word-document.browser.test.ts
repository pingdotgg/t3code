import JSZip from "jszip";
import { expect, it, vi } from "vite-plus/test";
import { openWordDocument } from "./word-document";

const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function relationship(id: string, type: string, target: string) {
  return `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
}

/** A document with a numbered Calibri paragraph and an Arial paragraph of Thai, which no bundled face covers. */
function document_() {
  const run = (font: string, text: string) =>
    `<w:r><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/></w:rPr><w:t>${text}</w:t></w:r>`;

  return new JSZip()
    .file(
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
    )
    .file(
      "_rels/.rels",
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship("rId1", "officeDocument", "word/document.xml")}</Relationships>`,
    )
    .file(
      "word/_rels/document.xml.rels",
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship("rId1", "numbering", "numbering.xml")}</Relationships>`,
    )
    .file(
      "word/numbering.xml",
      `<w:numbering ${ns}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
    )
    .file(
      "word/document.xml",
      `<w:document ${ns}><w:body><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run("Calibri", "Numbered")}</w:p><w:p>${run("Arial", "ภาษาไทย")}</w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
    )
    .generateAsync({ type: "uint8array" });
}

it("draws list numbers with the document's faces, and text no bundled face covers with the system's", async () => {
  const opened = await openWordDocument(await document_(), document.fonts);
  const drawn: { text: string; font: string }[] = [];
  using _fillText = vi
    .spyOn(OffscreenCanvasRenderingContext2D.prototype, "fillText")
    .mockImplementation(function (this: OffscreenCanvasRenderingContext2D, text) {
      drawn.push({ text, font: this.font });
    });

  await opened.paint(0, 1, 1, new AbortController().signal);

  expect(drawn.map((call) => call.text)).toEqual(expect.arrayContaining(["1.", "ภาษาไทย"]));
  expect(drawn.find((call) => call.text === "1.")?.font).toContain("Calibri");
  expect([...document.fonts].map((face) => face.family.replaceAll('"', ""))).toContain("Calibri");
});
