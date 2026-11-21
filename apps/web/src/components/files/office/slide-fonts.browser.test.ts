import JSZip from "jszip";
import { initWasm, openPresentation } from "@betteroffice/pptx";
import { expect, it } from "vite-plus/test";
import { slideFonts } from "./slide-fonts";
import { deckText } from "./slide-text";

const namespaces =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

function relationships(type: string, target: string) {
  return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/></Relationships>`;
}

/** A one-slide deck whose text box has one paragraph per run, each in its own family. */
async function deck(runs: readonly { text: string; family: string }[]) {
  const paragraphs = runs
    .map(
      (run) =>
        `<a:p><a:r><a:rPr lang="en-US" sz="2400"><a:latin typeface="${run.family}"/></a:rPr><a:t>${run.text}</a:t></a:r></a:p>`,
    )
    .join("");

  return new JSZip()
    .file(
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
    )
    .file("_rels/.rels", relationships("officeDocument", "ppt/presentation.xml"))
    .file(
      "ppt/presentation.xml",
      `<p:presentation ${namespaces}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`,
    )
    .file("ppt/_rels/presentation.xml.rels", relationships("slide", "slides/slide1.xml"))
    .file(
      "ppt/slides/slide1.xml",
      `<p:sld ${namespaces}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8229600" cy="2000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/>${paragraphs}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    )
    .generateAsync({ type: "uint8array" });
}

it("lays slide text out with heavy stand-ins and script fallbacks, and draws text no bundled face covers whole", async () => {
  await initWasm();
  const bytes = await deck([
    { text: "Plain", family: "Arial" },
    { text: "Heavy", family: "Arial Black" },
    { text: "日本語のテキスト", family: "Times New Roman" },
    { text: "ภาษาไทย", family: "Arial" },
  ]);
  const handle = openPresentation(bytes);
  const fonts = slideFonts(handle, document.fonts);

  await fonts.load(deckText(bytes, handle.snapshot()));

  const frame = await fonts.layout(0);
  const [plain, heavy, japanese, thai] = frame.primitives.flatMap((primitive) =>
    primitive.kind === "textBox" ? primitive.lines.flatMap((line) => line.runs) : [],
  );

  // Arial Black's only stand-in is a bold face, which its regular text draws with rather than Arial's.
  expect(heavy?.fontFamily).not.toBe(plain?.fontFamily);
  expect(plain?.glyphs).toHaveLength(5);
  expect(japanese?.fontFamily).not.toBe(plain?.fontFamily);
  expect(japanese?.glyphs.length).toBeGreaterThan(0);
  expect(japanese?.glyphs.some((glyph) => glyph.glyphId === 0)).toBe(false);
  expect(thai?.text).toBe("ภาษาไทย");
  expect(thai?.glyphs).toEqual([]);
});
