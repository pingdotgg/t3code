import { act, render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import "~/index.css";

const { refresh, assetUrlState } = vi.hoisted(() => ({
  refresh: vi.fn<() => Promise<string | null>>(),
  assetUrlState: vi.fn<() => import("~/assets/assetUrls").AssetUrlState>(),
}));

vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlRefresh: () => refresh,
  useAssetUrlState: assetUrlState,
}));
// The real source view highlights through a worker pool; the text it receives is what matters here.
// Never load the original: its highlighter graph can outlast waitFor on a cold CI browser.
vi.mock(import("./ReadOnlySourcePreview"), () => ({
  default: ({ text, wordWrap }: { text: string; wordWrap?: boolean }) => (
    <pre data-word-wrap={String(wordWrap)}>{text}</pre>
  ),
}));

// The Word engine compiles about 30 MB of WebAssembly in a fresh worker per document, which took
// 10-17 s per test on loaded CI runners. These tests cover fetching, preparation and remounts, so
// the stand-in shows the prepared body's text instead of laying it out.
vi.mock(import("./office/WordDocument"), async () => {
  const { use } = await import("react");
  const { default: Zip } = await import("jszip");
  const texts = new WeakMap<ArrayBuffer, Promise<string>>();
  const read = (bytes: ArrayBuffer) =>
    Zip.loadAsync(bytes)
      .then((zip) => zip.file("word/document.xml")!.async("string"))
      .then((xml) => xml.replace(/<[^>]+>/g, " "));
  return {
    default: ({ bytes }: { bytes: ArrayBuffer }) => {
      let text = texts.get(bytes);
      if (!text) texts.set(bytes, (text = read(bytes)));
      return <pre>{use(text)}</pre>;
    },
  };
});

import { AttachmentFilePreview } from "./AttachmentFilePreview";
import JSZip from "jszip";
import { OFFICE_PREVIEW_MAX_COLUMNS, type OfficeWorkerResult } from "./officePreviewProtocol";
import { WORD_LIMITS } from "./officeArchive";

it.each(["<w:body/>", "<w:body></w:body>"])(
  "opens an empty Word document with %s",
  async (body) => {
    const { default: JSZip } = await import("jszip");
    const { prepareOffice } = await import("./officeArchive");
    const archive = new JSZip().file(
      "word/document.xml",
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${body}</w:document>`,
    );
    const prepared = await prepareOffice(
      await archive.generateAsync({ type: "arraybuffer" }),
      "docx",
    );
    const result = await JSZip.loadAsync(prepared.bytes);
    const xml = new DOMParser().parseFromString(
      await result.file("word/document.xml")!.async("string"),
      "application/xml",
    );
    expect(xml.querySelector("parsererror")).toBeNull();
    expect(
      xml.getElementsByTagNameNS(
        "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
        "body",
      ),
    ).toHaveLength(1);
  },
);

it.each([false, true])(
  "rejects excessive archive entries before JSZip (directories: %s)",
  async (directories) => {
    const { default: JSZip } = await import("jszip");
    const { prepareOffice } = await import("./officeArchive");
    const archive = new JSZip();
    for (let i = 0; i < 4096; i++)
      archive.file(`entry-${i}${directories ? "/" : ".txt"}`, "", { dir: directories });
    const bytes = await archive.generateAsync({ type: "arraybuffer" });
    const load = vi.spyOn(JSZip, "loadAsync");
    try {
      await expect(prepareOffice(bytes, "docx")).rejects.toThrow("2,048 entries");
      expect(load).not.toHaveBeenCalled();
      // The actual central-directory records must also be bounded if EOCD lies.
      const view = new DataView(bytes);
      view.setUint16(bytes.byteLength - 22 + 8, 1, true);
      view.setUint16(bytes.byteLength - 22 + 10, 1, true);
      await expect(prepareOffice(bytes, "docx")).rejects.toThrow("2,048 entries");
      expect(load).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
    }
  },
);

it("rejects oversized embedded images before decoding pixels and retains ordinary images", async () => {
  const { officeImageBitmap } = await import("./office/image-bitmap");
  const canvas = new OffscreenCanvas(2, 3);
  canvas.getContext("2d");
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = await blob.arrayBuffer();
  new DataView(bytes).setUint32(16, 12000);
  new DataView(bytes).setUint32(20, 12000);
  const decode = vi.spyOn(globalThis, "createImageBitmap");
  try {
    await expect(officeImageBitmap(new Blob([bytes]))).rejects.toThrow("pixel limit");
    expect(decode).not.toHaveBeenCalled();
    const bitmap = await officeImageBitmap(blob);
    expect([bitmap.width, bitmap.height]).toEqual([2, 3]);
    bitmap.close();
  } finally {
    decode.mockRestore();
  }
});

it.each(["utf-16le", "utf-16be", "windows-1252"])(
  "preserves %s Office XML and safe hyperlink targets",
  async (encoding) => {
    const { default: JSZip } = await import("jszip");
    const { prepareOffice } = await import("./officeArchive");
    const archive = new JSZip();
    const encode = (text: string) => {
      const xml = `<?xml version="1.0" encoding="${encoding}"?>${text}`;
      if (encoding === "windows-1252") return Uint8Array.from(xml, (char) => char.charCodeAt(0));
      const bytes = new Uint8Array(2 + xml.length * 2);
      const view = new DataView(bytes.buffer);
      const little = encoding === "utf-16le";
      view.setUint16(0, 0xfeff, little);
      for (let i = 0; i < xml.length; i++) view.setUint16(2 + i * 2, xml.charCodeAt(i), little);
      return bytes;
    };
    archive.file(
      "word/document.xml",
      encode(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>café</w:t></w:r></w:p></w:body></w:document>',
      ),
    );
    archive.file(
      "word/_rels/document.xml.rels",
      encode(
        `<Relationships>${["https://example.com/page", "http://example.com", "mailto:maria@example.com", "javascript:alert(1)", "file:///tmp/private"].map((target, i) => `<Relationship Id="r${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" TargetMode="External" Target="${target}"/>`).join("")}</Relationships>`,
      ),
    );
    const prepared = await prepareOffice(
      await archive.generateAsync({ type: "arraybuffer" }),
      "docx",
    );
    const result = await JSZip.loadAsync(prepared.bytes);
    expect(await result.file("word/document.xml")!.async("string")).toContain("café");
    const links = await result.file("word/_rels/document.xml.rels")!.async("string");
    expect(links).toContain('encoding="UTF-8"');
    expect(links).toContain("https://example.com/page");
    expect(links).toContain("http://example.com");
    expect(links).toContain("mailto:maria@example.com");
    expect(links).not.toContain("javascript:");
    expect(links).not.toContain("file:");
  },
);

it.each([
  ["", "worksheets/./sheet1.xml", false, false],
  ["x:", "../xl/worksheets/sheet1.xml", false, false],
  ["", "/xl/worksheets/sheet1.xml", true, false],
  ["", "worksheets/sheet1.xml", false, true],
  ["", "worksheets/sheet1.xml", true, true],
])(
  "preserves %sworksheet metadata with relationship target %s",
  async (prefix, target, empty, localPrefix) => {
    const { default: JSZip } = await import("jszip");
    const archive = new JSZip();
    const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    archive.file(
      "xl/workbook.xml",
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Chart" sheetId="2" r:id="c"/><sheet name="Sheet" sheetId="1" r:id="s"/></sheets></workbook>',
    );
    archive.file(
      "xl/_rels/workbook.xml.rels",
      `<Relationships><Relationship Id="s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"/><Relationship Id="c" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet" Target="chartsheets/sheet1.xml"/></Relationships>`,
    );
    archive.file(
      "xl/worksheets/sheet1.xml",
      `<${prefix}worksheet xmlns${prefix ? ":x" : ""}="${ns}"><${prefix}dimension ref="XFD1048576"/><${prefix}sheetViews><${prefix}sheetView showGridLines="0"/></${prefix}sheetViews><${prefix}sheetFormatPr defaultColWidth="30"/><${prefix}cols><${prefix}col min="${OFFICE_PREVIEW_MAX_COLUMNS - 1}" max="${OFFICE_PREVIEW_MAX_COLUMNS + 10}" width="20"/><${prefix}col min="${OFFICE_PREVIEW_MAX_COLUMNS + 1}" max="${OFFICE_PREVIEW_MAX_COLUMNS + 30}" hidden="1"/></${prefix}cols><${prefix}sheetData><${prefix}row ht="42" customHeight="1" hidden="1"><${prefix}c r="A50" t="inlineStr"><${prefix}is><${prefix}t>${"value".repeat(1000)}</${prefix}t></${prefix}is></${prefix}c></${prefix}row></${prefix}sheetData><${prefix}mergeCells><${prefix}mergeCell ref="XFD1048576"/></${prefix}mergeCells></${prefix}worksheet>`
        .replace(
          /<((?:x:)?(?:col|dimension|mergeCell))\b([^>]*)\/>/g,
          prefix ? "<$1$2></$1>" : "$&",
        )
        .replace(/<sheetData>[\s\S]*?<\/sheetData>/, (data) => (empty ? "<sheetData/>" : data))
        .replace(/<(\/?)sheetData\b/g, (tag, closing: string) =>
          localPrefix ? `<${closing}x:sheetData${closing ? "" : ` xmlns:x="${ns}"`}` : tag,
        )
        .replace(/="([^"]*)"/g, (attribute, value: string) =>
          prefix || empty
            ? ` = '${value.replace(/\d/g, (digit) => `&#${digit.charCodeAt(0)};`)}'`
            : attribute,
        ),
    );
    const bytes = await archive.generateAsync({ type: "arraybuffer" });
    const worker = new Worker(new URL("./officePreview.worker.ts", import.meta.url), {
      type: "module",
    });
    try {
      const result = await new Promise<OfficeWorkerResult>((resolve) => {
        worker.addEventListener(
          "message",
          (event: MessageEvent<OfficeWorkerResult>) => resolve(event.data),
          { once: true },
        );
        worker.postMessage({ type: "open", kind: "xlsx", bytes }, [bytes]);
      });
      expect(result.type).toBe("xlsx");
      if (result.type !== "xlsx") throw new Error("Expected bounded workbook");
      // The engine counts the chart sheet before it.
      expect(result.view?.hiddenGridlines).toEqual([1]);
      const bounded = await JSZip.loadAsync(result.bytes);
      const sheet = new DOMParser().parseFromString(
        await bounded.file("xl/worksheets/sheet1.xml")!.async("string"),
        "application/xml",
      );
      expect(sheet.querySelector("parsererror")).toBeNull();
      const row = sheet.getElementsByTagNameNS(ns, "row")[0];
      if (empty) expect(row).toBeUndefined();
      else {
        expect(row!.getAttribute("ht")).toBe("42");
        expect(row!.getAttribute("hidden")).toBe("1");
        expect(row!.getElementsByTagNameNS(ns, "c")[0]!.getAttribute("r")).toBe("A50");
        expect(row!.getElementsByTagNameNS(ns, "t")[0]!.textContent).toHaveLength(4096);
      }
      expect(sheet.getElementsByTagNameNS(ns, "dimension")).toHaveLength(0);
      expect(sheet.getElementsByTagNameNS(ns, "mergeCell")).toHaveLength(0);
      const columns = [...sheet.getElementsByTagNameNS(ns, "col")].map((column) =>
        ["min", "max", "width"].map((name) => column.getAttribute(name)),
      );
      // The engine ignores `defaultColWidth`, so the columns it sizes are spelled out.
      expect(columns).toEqual([
        [String(OFFICE_PREVIEW_MAX_COLUMNS - 1), String(OFFICE_PREVIEW_MAX_COLUMNS), "20"],
        // Hidden columns keep their span past the limit, so they stay hidden.
        [String(OFFICE_PREVIEW_MAX_COLUMNS + 1), String(OFFICE_PREVIEW_MAX_COLUMNS + 30), null],
        ["1", String(OFFICE_PREVIEW_MAX_COLUMNS - 2), "30"],
      ]);
    } finally {
      worker.terminate();
    }
  },
);

it("reports the final slide at maximum scroll after page visibility changes", async () => {
  const { OfficePages } = await import("./office/OfficePages");
  const changed = vi.fn();
  const container = document.createElement("div");
  container.style.cssText = "display:flex;flex-direction:column;width:400px;height:400px";
  await using screen = await render(
    <OfficePages
      pages={Array.from({ length: 6 }, () => ({ width: 400, height: 240 }))}
      label="Slide"
      paint={async () => undefined}
      onPageChange={changed}
      onError={(error) => {
        throw error;
      }}
    />,
    { container },
  );
  const scroller = screen.container.querySelector<HTMLElement>("[data-office-pages]")!;
  await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight));
  await act(() => {
    scroller.scrollTop = scroller.scrollHeight;
  });
  await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(5));
  await act(() => {
    scroller.scrollTop = 10;
  });
  await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(0));
});

it("preserves merged text across tile clears", async () => {
  const { paintFrame } = await import("./office/sheet-frame");
  const canvas = new OffscreenCanvas(400, 80);
  const context = canvas.getContext("2d")!;
  paintFrame(
    context,
    {
      viewport: { x: 0, y: 0, width: 400, height: 80 },
      list: { width: 400, height: 80, commands: [] },
      tiles: [
        {
          x: 0,
          y: 0,
          clipX: 0,
          clipY: 0,
          list: {
            width: 208,
            height: 80,
            commands: [
              {
                op: "text",
                x: 2,
                y: 40,
                text: "MMMMMMMMMMMMMMMMMMMMMMMM",
                fontSize: 20,
                color: "#000",
                clip: { x: 0, y: 0, w: 400, h: 80 },
              },
            ],
          },
        },
        { x: 192, y: 0, clipX: 200, clipY: 0, list: { width: 208, height: 80, commands: [] } },
      ],
    },
    { ratio: 1, origin: { x: 0, y: 0 } },
  );
  const pixels = context.getImageData(240, 15, 100, 35).data;
  expect(pixels.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
});

it.each([
  "paragraphs",
  "runs",
  "tables",
  "auxiliary XML",
  "XML bytes",
  "renamed XML",
  "section after prefix",
  "oversized section",
])("bounds excessive Word %s before rendering DOM", async (scenario) => {
  const { default: JSZip } = await import("jszip");
  const archive = new JSZip();
  const body = ["paragraphs", "section after prefix", "oversized section"].includes(scenario)
    ? "<w:p><w:r><w:t>x</w:t></w:r></w:p>".repeat(200_000)
    : scenario === "runs"
      ? `<w:p>${"<w:r><w:t>x</w:t></w:r>".repeat(50_001)}</w:p>`
      : scenario === "tables"
        ? "<w:tbl/>".repeat(2 * WORD_LIMITS.bodyElements)
        : scenario === "XML bytes"
          ? `<w:p><w:r><w:t>${"x".repeat(2 * 1024 * 1024)}</w:t></w:r></w:p>`
          : "<w:p/>";
  const section =
    '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1440" w:left="1440" w:bottom="1440" w:right="1440"/></w:sectPr>';
  archive.file(
    "word/document.xml",
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}${scenario === "section after prefix" ? '<w:p xmlns:s="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:pPr><s:sectPr><s:pgSz s:w="11906" s:h="16838"/></s:sectPr></w:pPr></w:p>' : ""}${scenario === "oversized section" ? `<w:sectPr>${"<w:cols/>".repeat(2_001)}</w:sectPr>` : section}</w:body></w:document>`,
  );
  if (scenario === "auxiliary XML" || scenario === "renamed XML")
    archive.file(
      scenario === "renamed XML" ? "word/footnotes.dat" : "word/footnotes.xml",
      `<w:footnotes>${"<w:p/>".repeat(WORD_LIMITS.auxiliaryMarkup + 1)}</w:footnotes>`,
    );
  const file = await archive.generateAsync({ type: "blob", compression: "DEFLATE" });
  const src = URL.createObjectURL(file);
  try {
    const worker = new Worker(new URL("./officePreview.worker.ts", import.meta.url), {
      type: "module",
    });
    try {
      const result = await new Promise<OfficeWorkerResult>((resolve) => {
        worker.addEventListener(
          "message",
          (event: MessageEvent<OfficeWorkerResult>) => resolve(event.data),
          { once: true },
        );
        void file
          .arrayBuffer()
          .then((bytes) => worker.postMessage({ type: "open", kind: "docx", bytes }, [bytes]));
      });
      if (
        scenario === "auxiliary XML" ||
        scenario === "renamed XML" ||
        scenario === "oversized section"
      ) {
        expect(result).toMatchObject({
          type: "error",
          message: expect.stringContaining("Preview limited"),
        });
      } else {
        expect(result.type).toBe("docx");
        if (result.type !== "docx") throw new Error("Expected a Word prefix");
        expect(result.truncated).toBe(true);
        const bounded = await JSZip.loadAsync(result.bytes);
        const markup = await bounded.file("word/document.xml")!.async("string");
        {
          const xml = markup;
          const document = new DOMParser().parseFromString(xml, "application/xml");
          expect(document.querySelector("parsererror")).toBeNull();
          const bodies = document.getElementsByTagNameNS("*", "body");
          expect(bodies).toHaveLength(1);
          const section = bodies[0]!.lastElementChild!;
          expect(section.localName).toBe("sectPr");
          const size = section.getElementsByTagNameNS("*", "pgSz")[0]!;
          expect(size.getAttributeNS(section.namespaceURI, "w")).toBe(
            scenario === "section after prefix" ? "11906" : "16838",
          );
          expect(size.getAttributeNS(section.namespaceURI, "orient")).toBe(
            scenario === "section after prefix" ? null : "landscape",
          );
        }
        expect(markup.length).toBeLessThan(body.length);
        expect(markup.length).toBeLessThanOrEqual(WORD_LIMITS.bodyBytes);
        expect(markup.match(/<(?![!?/])/g)!.length).toBeLessThanOrEqual(WORD_LIMITS.bodyTags);
      }
    } finally {
      worker.terminate();
    }
  } finally {
    URL.revokeObjectURL(src);
  }
});

it.each([
  "relationship markup",
  "relationship bytes",
  "content type",
  "metadata type",
  "deep XML",
  "query path",
])("bounds XML hidden in media by %s", async (scenario) => {
  const { default: JSZip } = await import("jszip");
  const archive = new JSZip();
  const path = `word/media/payload.png${scenario === "query path" ? "?xml" : ""}`;
  archive.file(
    "word/document.xml",
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>',
  );
  archive.file(
    "[Content_Types].xml",
    `<Types><Override PartName="/${path}" ContentType="${scenario === "content type" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml" : "image/png"}"/>${scenario === "metadata type" ? '<Default Extension="rels" ContentType="image/png"/>' : ""}</Types>`,
  );
  archive.file(
    "word/_rels/document.xml.rels",
    `<Relationships>${scenario === "content type" ? "" : `<Relationship Id="style" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="${path.slice(5)}"/>`}${scenario === "metadata type" ? "<unused/>".repeat(WORD_LIMITS.auxiliaryMarkup + 1) : ""}</Relationships>`,
  );
  archive.file(
    path,
    scenario === "relationship bytes"
      ? `<styles>${"x".repeat(WORD_LIMITS.auxiliaryPartBytes)}</styles>`
      : scenario === "deep XML"
        ? `${"<styles>".repeat(65)}${"</styles>".repeat(65)}`
        : `<styles>${"<style/>".repeat(WORD_LIMITS.auxiliaryMarkup + 1)}</styles>`,
  );
  const bytes = await archive.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  const worker = new Worker(new URL("./officePreview.worker.ts", import.meta.url), {
    type: "module",
  });
  try {
    const result = await new Promise<OfficeWorkerResult>((resolve) => {
      worker.addEventListener(
        "message",
        (event: MessageEvent<OfficeWorkerResult>) => resolve(event.data),
        { once: true },
      );
      worker.postMessage({ type: "open", kind: "docx", bytes }, [bytes]);
    });
    expect(result).toMatchObject({
      type: "error",
      message: expect.stringContaining("Preview limited"),
    });
  } finally {
    worker.terminate();
  }
});

const EXPANDED_WORD_ROLES = [
  "footnotes",
  "note roots",
  "endnotes",
  "header",
  "footer",
  "comments",
  "styles",
  "style chain",
  "style count",
  "style visits",
  "numbering",
  "picture numbering",
] as const;

async function expandedWordFixture(role: (typeof EXPANDED_WORD_ROLES)[number]) {
  const archive = new JSZip();
  const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const type = role.startsWith("style")
    ? "styles"
    : role === "picture numbering"
      ? "numbering"
      : role === "note roots"
        ? "footnotes"
        : role;
  archive.file(
    "_rels/.rels",
    '<Relationships><Relationship Id="doc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const text = (value: string) => `<w:p><w:r><w:t>${value}</w:t></w:r></w:p>`;
  // Each copy of the 2,000-paragraph payload costs 6,000 markup units, so enough
  // references (or pages) exceed the expansion budget.
  const copies = Math.ceil(WORD_LIMITS.expandedMarkup / 6_000) + 1;
  archive.file(
    "word/document.xml",
    `<w:document xmlns:w="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${text("body retained")}${Array.from({ length: copies }, () => `<w:p><w:r><w:footnoteReference w:id="1"/><w:endnoteReference w:id="1"/><w:commentReference w:id="1"/><w:br w:type="page"/></w:r></w:p>`).join("")}<w:sectPr><w:headerReference w:type="default" r:id="aux"/><w:footerReference w:type="default" r:id="aux"/></w:sectPr></w:body></w:document>`,
  );
  archive.file(
    "word/_rels/document.xml.rels",
    `<Relationships><Relationship Id="aux" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="media/aux.xml"/></Relationships>`,
  );
  const xml =
    role === "style chain" || role === "style count" || role === "style visits"
      ? `<w:styles xmlns:w="${ns}">${Array.from({ length: role === "style count" ? WORD_LIMITS.styles + 1 : role === "style visits" ? Math.ceil(WORD_LIMITS.styleVisits / 30) + 1 : 1_000 }, (_, i) => `<w:style w:styleId="s${i}" w:type="paragraph">${i ? `<w:basedOn w:val="s${role === "style visits" && i >= 30 ? 29 : i - 1}"/>` : ""}<w:pPr><w:spacing w:after="120"/></w:pPr></w:style>`).join("")}</w:styles>`
      : role === "styles"
        ? `<w:styles xmlns:w="${ns}">${Array.from({ length: 100 }, (_, i) => `<w:style w:styleId="${"s".repeat(2_000)}${i}" w:type="paragraph"><w:basedOn w:val="s0"/><w:pPr><w:spacing w:after="120"/></w:pPr></w:style>`).join("")}</w:styles>`
        : role.includes("numbering")
          ? `<w:numbering xmlns:w="${ns}">${role === "picture numbering" ? '<w:numPicBullet w:numPicBulletId="1"/>' : ""}<w:abstractNum w:abstractNumId="1">${Array.from({ length: 9 }, (_, i) => `<w:lvl w:ilvl="${i}"><w:lvlText w:val="%1."/></w:lvl>`).join("")}</w:abstractNum>${Array.from({ length: WORD_LIMITS.numberingReferences + 1 }, (_, i) => `<w:num w:numId="${i}"><w:abstractNumId w:val="1"/></w:num>`).join("")}</w:numbering>`
          : role === "header" || role === "footer"
            ? `<w:${role === "header" ? "hdr" : "ftr"} xmlns:w="${ns}">${text("omitted payload").repeat(2_000)}</w:${role === "header" ? "hdr" : "ftr"}>`
            : `<w:${role} xmlns:w="${ns}"><w:${role.slice(0, -1)} w:id="1">${text("omitted payload").repeat(2_000)}</w:${role.slice(0, -1)}></w:${role}>`;
  archive.file("word/media/aux.xml", xml);
  if (role === "note roots") {
    // Each note's XML repeats the 32 KB root, which the expansion budget charges twice.
    const notes = Math.ceil(WORD_LIMITS.expandedBytes / 64_000) + 1;
    archive.file(
      "word/document.xml",
      `<w:document xmlns:w="${ns}"><w:body>${text("body retained")}${Array.from({ length: notes }, (_, id) => `<w:p><w:r><w:footnoteReference w:id="${id}"/></w:r></w:p>`).join("")}</w:body></w:document>`,
    );
    archive.file(
      "word/media/aux.xml",
      `<w:footnotes xmlns:w="${ns}" padding="${"x".repeat(32_000)}">${Array.from({ length: notes }, (_, id) => `<w:footnote w:id="${id}">${text("omitted payload")}</w:footnote>`).join("")}</w:footnotes>`,
    );
  }
  return archive.generateAsync({ type: "blob", compression: "DEFLATE" });
}

// Rendering starts a Word engine worker per case, which compiles about 30 MB of WebAssembly and
// took 10-17 s per test on loaded CI runners. Omission and retention are prepareOffice decisions,
// so they are checked there.
it.each(EXPANDED_WORD_ROLES)(
  "keeps the body and omits expanded %s from the prepared document",
  async (role) => {
    const file = await expandedWordFixture(role);
    const { SaxesParser } = await import("saxes");
    const { prepareOffice } = await import("./officeArchive");
    const parse = vi.spyOn(SaxesParser.prototype, "write");
    try {
      const prepared = await prepareOffice(await file.arrayBuffer(), "docx");
      expect(prepared.truncated).toBe(true);
      if (role === "note roots")
        expect(
          parse.mock.calls.reduce(
            (sum, [chunk]) => sum + (typeof chunk === "string" ? chunk.length : 0),
            0,
          ),
        ).toBeLessThan(WORD_LIMITS.expandedBytes + 4 * 1024 * 1024);
      const bounded = await JSZip.loadAsync(prepared.bytes);
      const markup = await bounded.file("word/document.xml")!.async("string");
      expect(markup).toContain("body retained");
      expect(bounded.file("word/media/aux.xml")).toBeNull();
      // A dangling header or footer reference makes the engine reject the whole body.
      expect(markup).not.toMatch(/<w:(header|footer)Reference/);
      for (const entry of Object.values(bounded.files))
        if (!entry.dir) expect(await entry.async("string")).not.toContain("omitted payload");
    } finally {
      parse.mockRestore();
    }
  },
);

it.each([
  "ordinary parts",
  "unused parts",
  "independent styles",
  "inherited styles",
  "python-docx package",
  "default template styles",
  "binary package properties",
])("retains Word %s without a limit warning", async (scenario) => {
  const { default: JSZip } = await import("jszip");
  const archive = new JSZip();
  const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const text = (value: string) => `<w:p><w:r><w:t>${value}</w:t></w:r></w:p>`;
  archive.file(
    "_rels/.rels",
    `<Relationships><Relationship Id="doc" Type="${r}/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  if (scenario === "python-docx package" || scenario === "binary package properties") {
    const packageRelationships = "http://schemas.openxmlformats.org/package/2006/relationships";
    archive.file(
      "_rels/.rels",
      `<Relationships xmlns="${packageRelationships}"><Relationship Id="doc" Type="${r}/officeDocument" Target="word/document.xml"/><Relationship Id="thumbnail" Type="${packageRelationships}/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/><Relationship Id="core" Type="${packageRelationships}/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="app" Type="${r}/extended-properties" Target="docProps/app.xml"/><Relationship Id="custom" Type="${r}/custom-properties" Target="docProps/custom.xml"/><Relationship Id="signature" Type="${packageRelationships}/digital-signature/origin" Target="_xmlsignatures/origin.sigs"/></Relationships>`,
    );
    archive.file(
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="sigs" ContentType="application/vnd.openxmlformats-package.digital-signature-origin"/></Types>',
    );
    archive.file(
      "docProps/thumbnail.jpeg",
      new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]),
    );
    archive.file("_xmlsignatures/origin.sigs", new Uint8Array());
    for (const part of ["core", "app", "custom"])
      archive.file(`docProps/${part}.xml`, '<properties xmlns="urn:properties"/>');
    if (scenario === "binary package properties") {
      const roles = [
        `${packageRelationships}/metadata/core-properties`,
        `${r}/extended-properties`,
        `${packageRelationships}/metadata/custom-properties`,
        `${packageRelationships}/digital-signature/signature`,
      ];
      archive.file(
        "_rels/.rels",
        `<Relationships><Relationship Id="doc" Type="${r}/officeDocument" Target="word/document.xml"/>${roles.map((role, i) => `<Relationship Id="metadata${i}" Type="${role}" Target="docProps/metadata${i}.dat"/>`).join("")}</Relationships>`,
      );
      for (const i of roles.keys())
        archive.file(`docProps/metadata${i}.dat`, new Uint8Array([255, 216, 255, 0]));
    }
  }
  const ordinary = scenario === "ordinary parts";
  archive.file(
    "word/document.xml",
    `<w:document xmlns:w="${ns}" xmlns:r="${r}"><w:body>${text("ordinary body")}<w:p><w:pPr><w:pStyle w:val="s19"/></w:pPr><w:r><w:t>styled body</w:t>${ordinary ? '<w:footnoteReference w:id="1"/><w:footnoteReference w:id="1"/><w:endnoteReference w:id="1"/><w:commentReference w:id="1"/>' : ""}</w:r></w:p><w:sectPr>${ordinary ? '<w:headerReference w:type="default" r:id="header"/><w:footerReference w:type="default" r:id="footer"/>' : ""}</w:sectPr></w:body></w:document>`,
  );
  archive.file(
    "word/_rels/document.xml.rels",
    `<Relationships>${["header", "footer", "footnotes", "endnotes", "comments", "fontTable", "styles"].map((role) => `<Relationship Id="${role}" Type="${r}/${role}" Target="${role}.xml"/>`).join("")}</Relationships>`,
  );
  for (const [role, root] of [
    ["header", "hdr"],
    ["footer", "ftr"],
  ])
    archive.file(
      `word/${role}.xml`,
      `<w:${root} xmlns:w="${ns}">${text(`${role} retained`)}</w:${root}>`,
    );
  for (const role of ["footnotes", "endnotes", "comments"])
    archive.file(
      `word/${role}.xml`,
      `<w:${role} xmlns:w="${ns}"><w:${role.slice(0, -1)} w:id="1" w:author="reviewer" w:date="2026-10-01T00:00:00Z">${text(`${role} retained`)}</w:${role.slice(0, -1)}></w:${role}>`,
    );
  archive.file(
    "word/fontTable.xml",
    `<w:fonts xmlns:w="${ns}"><w:font w:name="unused"/></w:fonts>`,
  );
  archive.file(
    "word/styles.xml",
    `<w:styles xmlns:w="${ns}"><w:docDefaults/><w:style w:type="paragraph" w:styleId="base"><w:rPr><w:b/></w:rPr></w:style>${Array.from({ length: 20 }, (_, i) => `<w:style w:styleId="s${i}" w:type="paragraph">${scenario === "inherited styles" ? '<w:basedOn w:val="base"/>' : ""}<w:rPr><w:color w:val="123456"/></w:rPr></w:style>`).join("")}</w:styles>`,
  );
  if (scenario === "default template styles") {
    const heading =
      '<w:style w:type="paragraph" w:styleId="s19"><w:basedOn w:val="Normal"/><w:link w:val="HeadingChar"/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="123456"/></w:rPr></w:style>';
    const conditions = [
      "wholeTable",
      "firstRow",
      "lastRow",
      "firstCol",
      "lastCol",
      "band1Horz",
      "band2Horz",
      "band1Vert",
      "band2Vert",
    ];
    archive.file(
      "word/styles.xml",
      `<w:styles xmlns:w="${ns}"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:latentStyles>${Array.from({ length: 276 }, (_, i) => `<w:lsdException w:name="latent ${i}" w:semiHidden="0" w:uiPriority="99"/>`).join("")}</w:latentStyles><w:style w:type="paragraph" w:styleId="Normal"/><w:style w:type="character" w:styleId="HeadingChar"><w:rPr><w:b/></w:rPr></w:style>${heading}${Array.from({ length: 61 }, (_, i) => `<w:style w:type="paragraph" w:styleId="p${i}"><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:color w:val="123456"/></w:rPr></w:style>`).join("")}${Array.from({ length: 100 }, (_, i) => `<w:style w:type="table" w:styleId="Table${i}">${i ? '<w:basedOn w:val="Table0"/>' : ""}<w:tblPr><w:tblCellMar><w:top w:w="0"/><w:left w:w="108"/><w:bottom w:w="0"/><w:right w:w="108"/></w:tblCellMar></w:tblPr>${conditions.map((type) => `<w:tblStylePr w:type="${type}"><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:b/><w:color w:val="123456"/></w:rPr><w:tcPr><w:shd w:fill="D9E2F3"/></w:tcPr></w:tblStylePr>`).join("")}</w:style>`).join("")}</w:styles>`,
    );
    archive.file(
      "word/_rels/document.xml.rels",
      (await archive.file("word/_rels/document.xml.rels")!.async("string")).replace(
        "</Relationships>",
        `<Relationship Id="numbering" Type="${r}/numbering" Target="numbering.xml"/></Relationships>`,
      ),
    );
    archive.file(
      "word/numbering.xml",
      `<w:numbering xmlns:w="${ns}">${Array.from({ length: 9 }, (_, i) => `<w:abstractNum w:abstractNumId="${i}"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="${i + 1}"><w:abstractNumId w:val="${i}"/></w:num>`).join("")}</w:numbering>`,
    );
    const document = await archive.file("word/document.xml")!.async("string");
    archive.file(
      "word/document.xml",
      document.replace(
        "<w:sectPr>",
        '<w:tbl><w:tblPr><w:tblStyle w:val="Table99"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>styled cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr>',
      ),
    );
  }
  const { prepareOffice } = await import("./officeArchive");
  const prepared = await prepareOffice(
    await archive.generateAsync({ type: "arraybuffer", compression: "DEFLATE" }),
    "docx",
  );
  expect(prepared.truncated).toBe(false);
  const bounded = await JSZip.loadAsync(prepared.bytes);
  const markup = await bounded.file("word/document.xml")!.async("string");
  expect(markup).toContain("ordinary body");
  expect(markup).toContain("styled body");
  expect(bounded.file("word/styles.xml")).not.toBeNull();
  if (scenario === "default template styles") {
    expect(markup).toContain("styled cell");
    expect(await bounded.file("word/styles.xml")!.async("string")).toContain('w:styleId="Table99"');
  }
  if (ordinary) {
    expect(markup).toMatch(/<w:headerReference/);
    expect(markup).toMatch(/<w:footerReference/);
    for (const role of ["header", "footer", "footnotes", "endnotes", "comments"])
      expect(await bounded.file(`word/${role}.xml`)!.async("string")).toContain(`${role} retained`);
  }
});

it.each([false, true])(
  "bounds shared-string text including CDATA %s per cell and across sheets in the worker",
  async (cdata) => {
    const { default: JSZip } = await import("jszip");
    const archive = new JSZip();
    archive.file(
      "xl/workbook.xml",
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="one" sheetId="1" r:id="s"/><sheet name="two" sheetId="2" r:id="s"/></sheets></workbook>',
    );
    archive.file(
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    );
    const sharedPath = cdata ? "customStrings.xml" : "sharedStrings.xml";
    archive.file(
      "xl/_rels/workbook.xml.rels",
      (await archive.file("xl/_rels/workbook.xml.rels")!.async("string")).replace(
        "</Relationships>",
        `<Relationship Id="strings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="${sharedPath}"/></Relationships>`,
      ),
    );
    const content = "x".repeat(32_767);
    archive.file(
      `xl/${sharedPath}`,
      `<sst><si><t>${cdata ? `<![CDATA[${content}]]>` : content}</t></si></sst>`,
    );
    archive.file(
      "xl/worksheets/sheet1.xml",
      `<worksheet><sheetData>${Array.from({ length: 500 }, (_, i) => `<row r="${i + 1}">${Array.from({ length: 50 }, (_, j) => `<c r="${j < 26 ? String.fromCharCode(65 + j) : "A" + String.fromCharCode(65 + j - 26)}${i + 1}" t="s"><v>${cdata ? "<![CDATA[0]]>" : "0"}</v></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`.replace(
        '<c r="A1" t="s"><v><![CDATA[0]]></v></c>',
        `<c r="A1" t="inlineStr"><is><t><![CDATA[${content}]]></t></is></c>`,
      ),
    );
    const file = await archive.generateAsync({ type: "blob", compression: "DEFLATE" });
    const worker = new Worker(new URL("./officePreview.worker.ts", import.meta.url), {
      type: "module",
    });
    try {
      const result = await new Promise<OfficeWorkerResult>((resolve) => {
        worker.addEventListener(
          "message",
          (event: MessageEvent<OfficeWorkerResult>) => resolve(event.data),
          { once: true },
        );
        void file
          .arrayBuffer()
          .then((bytes) => worker.postMessage({ type: "open", kind: "xlsx", bytes }, [bytes]));
      });
      expect(result.type).toBe("xlsx");
      if (result.type !== "xlsx") throw new Error("Expected bounded workbook");
      const bounded = await JSZip.loadAsync(result.bytes);
      const sheet = new DOMParser().parseFromString(
        await bounded.file("xl/worksheets/sheet1.xml")!.async("string"),
        "application/xml",
      );
      const cells = [...sheet.getElementsByTagName("t")].map((cell) => cell.textContent ?? "");
      expect(cells.reduce((total, cell) => total + cell.length, 0)).toBe(1024 * 1024);
      expect(Math.max(...cells.map((cell) => cell.length))).toBe(4096);
      expect(result.truncated).toBe(true);
    } finally {
      worker.terminate();
    }
  },
);

// A body just over the read limit once each paragraph repeats its text this often.
it.each([1, Math.ceil(WORD_LIMITS.bodyBytes / 5_000 / 4)])(
  "counts shared Word settings once with %s text repetitions",
  async (repetitions) => {
    const { default: JSZip } = await import("jszip");
    const archive = new JSZip();
    const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    archive.file(
      "word/document.xml",
      `<w:document xmlns:w="${ns}"><w:body>${`<w:p><w:r><w:t>${"body".repeat(repetitions)}</w:t></w:r></w:p>`.repeat(5_000)}</w:body></w:document>`,
    );
    archive.file(
      "word/_rels/document.xml.rels",
      '<Relationships><Relationship Id="settings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>',
    );
    const settings = `<w:settings xmlns:w="${ns}"><w:unused>${"s".repeat(120_000)}</w:unused></w:settings>`;
    archive.file("word/settings.xml", settings);
    const bytes = await archive.generateAsync({ type: "arraybuffer" });
    const worker = new Worker(new URL("./officePreview.worker.ts", import.meta.url), {
      type: "module",
    });
    try {
      const result = await new Promise<OfficeWorkerResult>((resolve) => {
        worker.addEventListener(
          "message",
          (event: MessageEvent<OfficeWorkerResult>) => resolve(event.data),
          { once: true },
        );
        worker.postMessage({ type: "open", kind: "docx", bytes }, [bytes]);
      });
      expect(result.type).toBe("docx");
      if (result.type !== "docx") throw new Error("Expected a Word prefix");
      expect(result.truncated).toBe(repetitions > 1);
      const bounded = await JSZip.loadAsync(result.bytes);
      const document = await bounded.file("word/document.xml")!.async("string");
      const retainedSettings = await bounded.file("word/settings.xml")!.async("string");
      expect(document.match(/<w:p>/g)!.length).toBeGreaterThan(100);
      expect(document.length).toBeLessThanOrEqual(WORD_LIMITS.bodyBytes);
      expect(retainedSettings).toBe(settings);
    } finally {
      worker.terminate();
    }
  },
);

it.each(["repeated binary", "XML relationship alias", "duplicate relationship ID"])(
  "bounds Word image expansion for %s",
  async (scenario) => {
    const { default: JSZip } = await import("jszip");
    const archive = new JSZip();
    archive.file(
      "[Content_Types].xml",
      '<Types><Default Extension="png" ContentType="image/png"/></Types>',
    );
    archive.file(
      "word/_rels/document.xml.rels",
      `<Relationships><Relationship Id="image" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${scenario === "XML relationship alias" ? "styles" : "image"}" Target="media/payload.png"/>${scenario === "duplicate relationship ID" ? '<Relationship Id="image" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/tiny.png"/>' : ""}</Relationships>`,
    );
    archive.file(
      "word/media/payload.png",
      scenario === "XML relationship alias" ? "<styles/>" : new Uint8Array(8 * 1024 * 1024),
    );
    if (scenario === "duplicate relationship ID")
      archive.file("word/media/tiny.png", new Uint8Array(1));
    archive.file(
      "word/document.xml",
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p>${'<w:r><a:blip r:embed="image"/></w:r>'.repeat(7)}</w:p></w:body></w:document>`,
    );
    const bytes = await archive.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
    const worker = new Worker(new URL("./officePreview.worker.ts", import.meta.url), {
      type: "module",
    });
    try {
      const result = await new Promise<OfficeWorkerResult>((resolve) => {
        worker.addEventListener(
          "message",
          (event: MessageEvent<OfficeWorkerResult>) => resolve(event.data),
          { once: true },
        );
        worker.postMessage({ type: "open", kind: "docx", bytes }, [bytes]);
      });
      expect(result).toMatchObject({
        type: "error",
        message: expect.stringContaining("expanded markup"),
      });
    } finally {
      worker.terminate();
    }
  },
);

it.each(["XFD200", "XFD300", "XFD1048576", "AX500", "AZ9999999"])(
  "bounds spreadsheet cells at %s before padding",
  async (ref) => {
    const { default: JSZip } = await import("jszip");
    const archive = new JSZip();
    archive.file(
      "xl/workbook.xml",
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet" sheetId="1" r:id="rId1"/></sheets></workbook>',
    );
    // A nonstandard relationship target must get the same bounds.
    archive.file(
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="custom.xml"/></Relationships>',
    );
    archive.file(
      "xl/custom.xml",
      `<worksheet><dimension ref="A1:${ref}"/><sheetData><row r="1"><c r="A1"><v>7</v></c></row><row r="${ref.replace(/\D/g, "")}">${ref === "XFD300" ? `<c r="${ref}" s="1"/>` : `<c r="${ref}"><v>9</v></c>`}</row></sheetData></worksheet>`,
    );
    const bytes = await archive.generateAsync({ type: "arraybuffer" });
    const worker = new Worker(new URL("./officePreview.worker.ts", import.meta.url), {
      type: "module",
    });
    try {
      const result = await new Promise<OfficeWorkerResult>((resolve) => {
        worker.addEventListener(
          "message",
          (event: MessageEvent<OfficeWorkerResult>) => resolve(event.data),
          { once: true },
        );
        worker.postMessage({ type: "open", kind: "xlsx", bytes }, [bytes]);
      });
      if (ref === "AZ9999999" || ref === "XFD1048576") {
        expect(result).toMatchObject({
          type: "error",
          message: expect.stringContaining(ref === "AZ9999999" ? "invalid" : "preview limit"),
        });
      } else {
        expect(result.type).toBe("xlsx");
        if (result.type !== "xlsx") throw new Error("Expected workbook values");
        const bounded = await JSZip.loadAsync(result.bytes);
        const sheet = new DOMParser().parseFromString(
          await bounded.file("xl/custom.xml")!.async("string"),
          "application/xml",
        );
        expect(sheet.querySelector('c[r="A1"] v')?.textContent).toBe("7");
        expect(sheet.querySelectorAll("row").length).toBeLessThanOrEqual(500);
        expect(result.truncated).toBe(ref === "XFD200" || ref === "XFD300");
        if (ref === "AX500") expect(sheet.querySelector('c[r="AX500"] v')?.textContent).toBe("9");
        else expect(sheet.querySelector('c[r="' + ref + '"]')).toBeNull();
      }
    } finally {
      worker.terminate();
    }
  },
);

it.each(['<u val="double"/>', '<u val="double"></u>'])(
  "shows workbook formats and underline %s",
  async (underline) => {
    const { default: JSZip } = await import("jszip");
    const archive = new JSZip();
    archive.file(
      "xl/workbook.xml",
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Styles" sheetId="1" r:id="rId1"/></sheets></workbook>',
    );
    archive.file(
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    );
    archive.file(
      "xl/styles.xml",
      `<styleSheet><numFmts count="4"><numFmt numFmtId="164" formatCode="0.000"/><numFmt numFmtId="65535" formatCode="0.0000"/><numFmt numFmtId="007" formatCode="&quot;￥&quot;#,##0.00"/><numFmt numFmtId="82" formatCode="[$-010409]dd-mmm-yyyy"/></numFmts><fonts count="2"><font><sz val="11"/></font><font>${underline}<sz val="11"/></font></fonts><cellXfs count="4"><xf numFmtId="0" fontId="0"/><xf numFmtId="7" fontId="0"/><xf numFmtId="82" fontId="0"/><xf numFmtId="0" fontId="1"/></cellXfs></styleSheet>`,
    );
    archive.file(
      "xl/worksheets/sheet1.xml",
      '<worksheet><sheetData><row r="1"><c r="A1" s="1"><v>100</v></c><c r="B1" s="2"><v>44986</v></c><c r="C1" s="3" t="inlineStr"><is><t>Total</t></is></c></row></sheetData></worksheet>',
    );
    const { prepareOffice } = await import("./officeArchive");
    const prepared = await prepareOffice(
      await archive.generateAsync({ type: "arraybuffer" }),
      "xlsx",
    );
    const styles = await (
      await JSZip.loadAsync(prepared.bytes)
    )
      .file("xl/styles.xml")!
      .async("string");
    expect(styles).toContain("<font><u/>");
    const worker = new Worker(new URL("./office/spreadsheet.worker.ts", import.meta.url), {
      type: "module",
    });
    try {
      const { createWorkerClient } = await import("./office/worker-rpc");
      const client = createWorkerClient<import("./office/sheet-protocol").SheetMethods>(worker);
      const bytes = prepared.bytes;
      await client.call("open", { bytes, view: prepared.view! }, { transfer: [bytes] });
      const cells = await client.call("cells", {
        sheet: 0,
        range: { top: 0, bottom: 0, left: 0, right: 1 },
      });
      // Ids under 164 that a workbook defines keep its formats, not Excel's built-in ones.
      expect(cells[0]).toEqual(["￥100.00", "01-Mar-2023"]);
    } finally {
      worker.terminate();
    }
    archive.file("xl/styles.xml", "<styleSheet><numFmts/><numFmts/></styleSheet>");
    await expect(
      prepareOffice(await archive.generateAsync({ type: "arraybuffer" }), "xlsx"),
    ).rejects.toThrow("duplicate stylesheet blocks");
  },
);

it("keeps spreadsheet dates on their calendar day west of UTC", async () => {
  const { default: JSZip } = await import("jszip");
  const archive = new JSZip();
  archive.file(
    "xl/workbook.xml",
    '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Dates" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  archive.file(
    "xl/_rels/workbook.xml.rels",
    '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  archive.file(
    "xl/styles.xml",
    '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
  );
  archive.file(
    "xl/worksheets/sheet1.xml",
    '<worksheet><sheetData><row r="1"><c r="A1" s="1"><v>46023</v></c></row></sheetData></worksheet>',
  );
  const bytes = await archive.generateAsync({ type: "arraybuffer" });
  const workerModule = new URL(
    "./office/spreadsheet.worker.ts?worker_file&type=module",
    import.meta.url,
  ).href;
  // Give the worker a west-of-UTC default while preserving explicit format options.
  const bootstrap = URL.createObjectURL(
    new Blob(
      [
        `
    const NativeURL = URL;
    globalThis.URL = class extends NativeURL {
      constructor(input, base) { super(input, base?.startsWith("blob:") ? ${JSON.stringify(location.href)} : base); }
    };
    const format = Date.prototype.toLocaleDateString;
    Date.prototype.toLocaleDateString = function(locale, options) {
      return format.call(this, "en-US", { timeZone: "America/Los_Angeles", ...options });
    };
    await import(${JSON.stringify(workerModule)});
    postMessage({ type: "ready" });
  `,
      ],
      { type: "text/javascript" },
    ),
  );
  const worker = new Worker(bootstrap, { type: "module" });
  try {
    await new Promise<void>((resolve, reject) => {
      worker.addEventListener(
        "message",
        (event) => {
          if (event.data.type === "ready") resolve();
        },
        { once: true },
      );
      worker.addEventListener("error", (event) => reject(new Error(event.message)), { once: true });
    });
    const { createWorkerClient } = await import("./office/worker-rpc");
    const client = createWorkerClient<import("./office/sheet-protocol").SheetMethods>(worker);
    await client.call(
      "open",
      {
        bytes,
        view: { hiddenGridlines: [], themeFonts: { major: "Calibri Light", minor: "Calibri" } },
      },
      { transfer: [bytes] },
    );
    const cells = await client.call("cells", {
      sheet: 0,
      range: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    expect(cells[0]![0]).toMatch(/^1\/1\/(26|2026)$/);
  } finally {
    worker.terminate();
    URL.revokeObjectURL(bootstrap);
  }
});

it.each([60, 100])("prepares all %i pages of a table-heavy Word report", async (pages) => {
  const { default: JSZip } = await import("jszip");
  const archive = new JSZip();
  const paragraph = (text: string) =>
    `<w:p><w:pPr><w:spacing w:after="120"/><w:jc w:val="left"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri"/><w:sz w:val="22"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
  archive.file(
    "word/document.xml",
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${Array.from({ length: pages }, (_, page) => paragraph(`page ${page + 1}`) + `<w:tbl>${Array.from({ length: 10 }, () => `<w:tr>${Array.from({ length: 5 }, () => `<w:tc><w:tcPr><w:tcW w:w="1800"/></w:tcPr>${paragraph("report entry")}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`).join("")}</w:body></w:document>`,
  );
  archive.file(
    "_rels/.rels",
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  archive.file(
    "[Content_Types].xml",
    '<Types><Default Extension="png" ContentType="image/png"/></Types>',
  );
  // Binary media must not consume the document's markup budget.
  archive.file("word/media/image.png", new Uint8Array(2_500_000));
  const file = await archive.generateAsync({ type: "blob", compression: "DEFLATE" });
  await using screen = await render(
    <AttachmentFilePreview
      name="report.docx"
      mimeType="application/octet-stream"
      file={file}
      sizeBytes={file.size}
    />,
  );
  // The first Office preview in the file loads the lazy viewer chain and the preparation worker.
  await vi.waitFor(() => expect(screen.container.textContent).toContain("page " + pages), {
    timeout: 10_000,
  });
  expect(screen.container.textContent).not.toContain("Preview limited");
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
});
