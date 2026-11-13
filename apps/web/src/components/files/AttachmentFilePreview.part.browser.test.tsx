import DocumentPages, { sanitizeDocumentHtml } from "./DocumentPages";
import { act, render, stubGlobal, type Screen } from "../../../test/render";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
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
vi.mock(import("./ReadOnlySourcePreview"), () => ({
  default: ({ text, wordWrap }: { text: string; wordWrap?: boolean }) => (
    <pre data-word-wrap={String(wordWrap)}>{text}</pre>
  ),
}));
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
import { getClientSettings } from "~/hooks/useSettings";
import { AttachmentFilePreview } from "./AttachmentFilePreview";
import LargeTextViewer from "./LargeTextViewer";
import VirtualTablePreview from "./VirtualTablePreview";
import { OfficeFilePreview } from "./OfficeFilePreview";
import { MermaidFilePreview } from "./MermaidFilePreview";
import JSZip from "jszip";
import { boundedZip } from "@t3tools/client-runtime/zip/bounded-zip";
import BinaryViewer from "./BinaryViewer";
import { decodeImagePreview } from "./decodeImagePreview";
import type { BinaryWorkerResult } from "./binaryPreviewProtocol";
import type { TextPreviewResult } from "./largeTextProtocol";
import { OFFICE_PREVIEW_MAX_COLUMNS, type OfficeWorkerResult } from "./officePreviewProtocol";

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
  // Each copy of the 2,000-paragraph payload costs 8,000 markup units, so 20
  // references (or pages) exceed the 100,000-unit expansion budget.
  archive.file(
    "word/document.xml",
    `<w:document xmlns:w="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${text("body retained")}${Array.from({ length: 20 }, () => `<w:p><w:r><w:footnoteReference w:id="1"/><w:endnoteReference w:id="1"/><w:commentReference w:id="1"/><w:br w:type="page"/></w:r></w:p>`).join("")}<w:sectPr><w:headerReference w:type="default" r:id="aux"/><w:footerReference w:type="default" r:id="aux"/></w:sectPr></w:body></w:document>`,
  );
  archive.file(
    "word/_rels/document.xml.rels",
    `<Relationships><Relationship Id="aux" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="media/aux.xml"/></Relationships>`,
  );
  const xml =
    role === "style chain" || role === "style count" || role === "style visits"
      ? `<w:styles xmlns:w="${ns}">${Array.from({ length: role === "style count" ? 3_000 : 1_000 }, (_, i) => `<w:style w:styleId="s${i}" w:type="paragraph">${i ? `<w:basedOn w:val="s${role === "style visits" && i >= 30 ? 29 : i - 1}"/>` : ""}<w:pPr><w:spacing w:after="120"/></w:pPr></w:style>`).join("")}</w:styles>`
      : role === "styles"
        ? `<w:styles xmlns:w="${ns}">${Array.from({ length: 100 }, (_, i) => `<w:style w:styleId="${"s".repeat(2_000)}${i}" w:type="paragraph"><w:basedOn w:val="s0"/><w:pPr><w:spacing w:after="120"/></w:pPr></w:style>`).join("")}</w:styles>`
        : role.includes("numbering")
          ? `<w:numbering xmlns:w="${ns}">${role === "picture numbering" ? '<w:numPicBullet w:numPicBulletId="1"/>' : ""}<w:abstractNum w:abstractNumId="1">${Array.from({ length: 9 }, (_, i) => `<w:lvl w:ilvl="${i}"><w:lvlText w:val="%1."/></w:lvl>`).join("")}</w:abstractNum>${Array.from({ length: 100 }, (_, i) => `<w:num w:numId="${i}"><w:abstractNumId w:val="1"/></w:num>`).join("")}</w:numbering>`
          : role === "header" || role === "footer"
            ? `<w:${role === "header" ? "hdr" : "ftr"} xmlns:w="${ns}">${text("omitted payload").repeat(2_000)}</w:${role === "header" ? "hdr" : "ftr"}>`
            : `<w:${role} xmlns:w="${ns}"><w:${role.slice(0, -1)} w:id="1">${text("omitted payload").repeat(2_000)}</w:${role.slice(0, -1)}></w:${role}>`;
  archive.file("word/media/aux.xml", xml);
  if (role === "note roots") {
    archive.file(
      "word/document.xml",
      `<w:document xmlns:w="${ns}"><w:body>${text("body retained")}${Array.from({ length: 200 }, (_, id) => `<w:p><w:r><w:footnoteReference w:id="${id}"/></w:r></w:p>`).join("")}</w:body></w:document>`,
    );
    archive.file(
      "word/media/aux.xml",
      `<w:footnotes xmlns:w="${ns}" padding="${"x".repeat(32_000)}">${Array.from({ length: 200 }, (_, id) => `<w:footnote w:id="${id}">${text("omitted payload")}</w:footnote>`).join("")}</w:footnotes>`,
    );
  }
  return archive.generateAsync({ type: "blob", compression: "DEFLATE" });
}

function planningPdf(
  titles = ["Quarterly outlook", "Delivery milestones", "Budget and risks"],
  firstHeight = 140,
  pageHeight = 792,
) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${titles.length} /Kids [${titles.map((_, index) => `${3 + index * 2} 0 R`).join(" ")}] >>`,
  ];
  const font = 3 + titles.length * 2;
  for (const [index, title] of titles.entries()) {
    const text = `/GS1 gs BT /F1 24 Tf 30 ${index === 0 ? 70 : 700} Td ${index === 0 ? "(Quarter) Tj /F2 24 Tf (ly outlook) Tj" : `(${title}) Tj`} ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${index === 0 ? firstHeight : pageHeight}] /Rotate ${index === 2 ? 90 : 0} /Resources << /Font << /F1 ${font} 0 R /F2 ${font + 1} 0 R >> /ExtGState << /GS1 << /TR << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 2 >> >> >> >> /Contents ${4 + index * 2} 0 R >>`,
      `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    );
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([source], { type: "application/pdf" });
}

async function workspacePdfPreview() {
  assetUrlState.mockReset();
  const { WorkspaceBrowserPreview } = await import("./FilePreviewPanel");
  const native = vi.spyOn(navigator, "pdfViewerEnabled", "get").mockReturnValue(false);
  const urls = (() => {
    const original = URL.createObjectURL(planningPdf());
    const updated = URL.createObjectURL(
      planningPdf(["Quarterly outlook", "Delivery milestones", "Updated budget"], 500),
    );
    const shorter = URL.createObjectURL(planningPdf(["Quarterly outlook", "Updated milestones"]));
    const shrunk = URL.createObjectURL(
      planningPdf(["Quarterly outlook", "Small page", "Budget and risks"], 500, 200),
    );
    const single = URL.createObjectURL(planningPdf(["Quarterly outlook"]));
    return {
      original,
      updated,
      shorter,
      shrunk,
      single,
      [Symbol.dispose]: () =>
        [original, updated, shorter, shrunk, single].forEach(URL.revokeObjectURL),
    };
  })();
  const threadId = ThreadId.make(urls.original);
  const preview = (src: string, mutation: string, path = "/repo/planning.pdf") => {
    assetUrlState.mockReturnValue({
      _tag: "Success",
      url: `${src}#preview`,
      expiresAt: Date.now() + 3_600_000,
    });
    return (
      <div className="flex h-[600px] w-[320px]">
        <WorkspaceBrowserPreview
          environmentId={EnvironmentId.make("test")}
          threadRef={{ environmentId: EnvironmentId.make("test"), threadId }}
          draft={false}
          absolutePath={path}
          workspaceRoot="/repo"
          title="Planning PDF"
          workspaceMutationId={mutation}
        />
      </div>
    );
  };
  return {
    preview,
    urls,
    [Symbol.dispose]() {
      native.mockRestore();
      urls[Symbol.dispose]();
    },
  };
}

function pdfScroll(screen: Screen) {
  const region = () => screen.container.querySelector<HTMLElement>('[role="region"]')!;
  const canvas = (page: number) =>
    region().querySelector<HTMLCanvasElement>(`canvas[aria-label="Page ${page}"]`)!;
  const offset = (page: number) =>
    region().getBoundingClientRect().top - canvas(page).getBoundingClientRect().top;
  const scrollTo = (options: ScrollToOptions) =>
    act(async () => {
      const node = region();
      const scrolled = new Promise<void>((resolve) =>
        node.addEventListener("scroll", () => resolve(), { once: true }),
      );
      node.scrollTo(options);
      await scrolled;
    });
  return { region, canvas, offset, scrollTo };
}

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
        ? "<w:tbl/>".repeat(50_001)
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
      `<w:footnotes>${"<w:p/>".repeat(50_001)}</w:footnotes>`,
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
        expect(markup.length).toBeLessThanOrEqual(3 * 1024 * 1024);
        expect(markup.match(/<(?![!?/])/g)!.length).toBeLessThanOrEqual(100_000);
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
    `<Relationships>${scenario === "content type" ? "" : `<Relationship Id="style" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="${path.slice(5)}"/>`}${scenario === "metadata type" ? "<unused/>".repeat(50_001) : ""}</Relationships>`,
  );
  archive.file(
    path,
    scenario === "relationship bytes"
      ? `<styles>${"x".repeat(1024 * 1024)}</styles>`
      : scenario === "deep XML"
        ? `${"<styles>".repeat(65)}${"</styles>".repeat(65)}`
        : `<styles>${"<style/>".repeat(50_001)}</styles>`,
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
        ).toBeLessThan(4 * 1024 * 1024);
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

it.each([1, 145])(
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
      expect(document.length + retainedSettings.length).toBeLessThanOrEqual(3 * 1024 * 1024);
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

it.each(["XFD200", "XFD1048576", "AX500", "AZ9999999"])(
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
      `<worksheet><dimension ref="A1:${ref}"/><sheetData><row r="1"><c r="A1"><v>7</v></c></row><row r="${ref.replace(/\D/g, "")}"><c r="${ref}"><v>9</v></c></row></sheetData></worksheet>`,
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
        expect(result.truncated).toBe(ref !== "AX500");
        if (ref === "AX500") expect(sheet.querySelector('c[r="AX500"] v')?.textContent).toBe("9");
        else expect(sheet.querySelector('c[r="' + ref + '"]')).toBeNull();
      }
    } finally {
      worker.terminate();
    }
  },
);
