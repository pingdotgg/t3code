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

describe("large text preview recovery", () => {
  it("scrolls every tall row in the final virtual viewport", async () => {
    const view = (loaded: boolean) => (
      <div style={{ display: "flex", height: 400, width: 600 }}>
        <VirtualTablePreview
          name="tail.txt"
          count={100}
          columns={1}
          source
          wrap
          getRows={(page) =>
            !loaded && page > 0
              ? undefined
              : Array.from({ length: 32 }, (_, i) => [
                  "line-" + (page * 32 + i + 1) + " wrapped source text".repeat(500),
                ])
          }
        />
      </div>
    );
    await using screen = await render(view(false));
    const viewport = () => screen.container.querySelector<HTMLElement>('[tabindex="0"]')!;
    const row = (index: number) =>
      screen.container.querySelector<HTMLElement>('[data-preview-row="' + index + '"]')!;
    await vi.waitFor(() => expect(row(0)?.offsetHeight).toBeGreaterThan(1000));
    await act(() =>
      viewport().dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
    );
    await vi.waitFor(() => expect(row(99)).not.toBeNull());
    await screen.rerender(view(true));
    await vi.waitFor(() =>
      expect(
        Math.abs(
          row(99).getBoundingClientRect().bottom - viewport().getBoundingClientRect().bottom,
        ),
      ).toBeLessThan(2),
    );
    await act(() =>
      viewport().dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })),
    );
    await vi.waitFor(() => expect(row(0)).not.toBeNull());
    await act(() => {
      viewport().scrollTop = 100 * 29 - viewport().clientHeight;
      viewport().dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const checkTop = (index: number) =>
      expect(
        Math.abs(row(index).getBoundingClientRect().top - viewport().getBoundingClientRect().top),
      ).toBeLessThan(2);
    await vi.waitFor(() => checkTop(87));
    for (let index = 88; index < 100; index++) {
      await act(() =>
        viewport().dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: row(index - 1).offsetHeight,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      if (index < 99) await vi.waitFor(() => checkTop(index));
    }
    await act(() =>
      viewport().dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
    );
    await vi.waitFor(() =>
      expect(
        Math.abs(
          row(99).getBoundingClientRect().bottom - viewport().getBoundingClientRect().bottom,
        ),
      ).toBeLessThan(2),
    );
  });

  it("rejects malformed UTF-8 bytes through the real text worker", async () => {
    const src = URL.createObjectURL(new Blob([new Uint8Array([0xe9, 10])]));
    try {
      await using screen = await render(
        <LargeTextViewer src={src} name="latin.txt" delimiter={null} />,
      );
      await vi.waitFor(
        () => expect(screen.container.querySelector('[role="alert"]')).not.toBeNull(),
        10_000,
      );
    } finally {
      URL.revokeObjectURL(src);
    }
  });

  it("replaces both prefetched pages with the worker's current file version", async () => {
    const old = Array.from({ length: 64 }, (_, i) => "old-" + i).join("\n") + "\n";
    const current = Array.from({ length: 100 }, (_, i) => "current-" + i).join("\n");
    const src = URL.createObjectURL(new Blob([current]));
    using _fetch = stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(old, {
          status: 206,
          headers: {
            "content-length": String(old.length),
            "content-range": "bytes 0-" + (old.length - 1) + "/100000",
          },
        }),
      ),
    );
    try {
      await using screen = await render(
        <div style={{ display: "flex", height: 2000, width: 600 }}>
          <LargeTextViewer src={src} name="log.txt" delimiter={null} />
        </div>,
      );
      await vi.waitFor(() => expect(screen.container.textContent).toContain("current-40"), 10_000);
      expect(screen.container.textContent).not.toContain("old-");
    } finally {
      URL.revokeObjectURL(src);
    }
  });

  it("fills the horizontal viewport using measured column widths", async () => {
    const header = Array.from({ length: 20 }, (_, i) => "C" + i);
    await using screen = await render(
      <div style={{ display: "flex", height: 400, width: 400 }}>
        <VirtualTablePreview
          name="wide.csv"
          count={2}
          columns={20}
          header={header}
          getRows={() => [header, header]}
        />
      </div>,
    );
    const outer = () => screen.container.querySelector('[role="table"]')!.parentElement!;
    const check = () => {
      const cells = screen.container.querySelectorAll('[role="columnheader"]');
      expect(cells.length).toBeGreaterThan(0);
      expect(cells[cells.length - 1]!.getBoundingClientRect().right).toBeGreaterThanOrEqual(
        outer().getBoundingClientRect().right - 1,
      );
    };
    await vi.waitFor(check);
    await act(() => {
      outer().scrollLeft = outer().scrollWidth;
      outer().dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await vi.waitFor(check);
    expect(screen.container.textContent).toContain("C19");
  });

  it("reveals and highlights requested source lines again for a new request", async () => {
    const view = (line: number, request: number, loaded = true) => (
      <div style={{ display: "flex", height: 400, width: 600 }}>
        <VirtualTablePreview
          name="log.txt"
          count={1000}
          columns={1}
          source
          wrap
          revealLine={line}
          revealRequestId={request}
          getRows={(page) =>
            loaded || page === 0
              ? Array.from({ length: 32 }, (_, i) => [
                  "line-" + (page * 32 + i + 1) + " wrapped source text".repeat(20),
                ])
              : undefined
          }
        />
      </div>
    );
    await using screen = await render(view(500, 1, false));
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[data-preview-reveal="true"]')?.textContent).toBe(
        "500",
      ),
    );
    await screen.rerender(view(500, 1));
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[data-preview-reveal="true"]')?.textContent).toContain(
        "line-500",
      ),
    );
    const checkVisible = () => {
      const row = screen.container.querySelector<HTMLElement>('[data-preview-reveal="true"]')!;
      const viewport = screen.container.querySelector<HTMLElement>('[tabindex="0"]')!;
      expect(row.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        viewport.getBoundingClientRect().top - 1,
      );
      expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        viewport.getBoundingClientRect().bottom + 1,
      );
    };
    await vi.waitFor(checkVisible);
    await screen.rerender(view(900, 2));
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[data-preview-reveal="true"]')?.textContent).toContain(
        "line-900",
      ),
    );
    await vi.waitFor(checkVisible);
    await screen.rerender(view(999, 3));
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[data-preview-reveal="true"]')?.textContent).toContain(
        "line-999",
      ),
    );
    await vi.waitFor(checkVisible);
  });

  it.each(
    [5, 100, 10_000].flatMap((count) => [false, true].map((mixed) => [count, mixed] as const)),
  )(
    "preserves the source row when indexing grows beyond %i lines (mixed heights: %s)",
    async (count, mixed) => {
      const view = (count: number) => (
        <div style={{ display: "flex", height: 400, width: 600 }}>
          <VirtualTablePreview
            name="growing.txt"
            count={count}
            columns={1}
            source
            wrap
            getRows={(page) =>
              Array.from({ length: 32 }, (_, i) => [
                `line-${page * 32 + i + 1} ` +
                  "wrapped source text ".repeat(mixed ? 5 + (i % 4) * 20 : 20),
              ])
            }
          />
        </div>
      );
      await using screen = await render(view(count));
      const viewport = () => screen.container.querySelector<HTMLElement>('[tabindex="0"]')!;
      await vi.waitFor(() => expect(viewport()?.scrollHeight).toBeGreaterThan(400));
      await act(() => {
        viewport().scrollTop = count === 100 ? 100 * 29 - 400 + 1200 : 1200;
        viewport().dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      const visibleRow = () =>
        [...screen.container.querySelectorAll<HTMLElement>("[data-preview-row]")].find(
          (row) => row.getBoundingClientRect().bottom > viewport().getBoundingClientRect().top + 1,
        )!;
      await vi.waitFor(() => expect(visibleRow()).toBeDefined());
      const before = visibleRow().dataset.previewRow;
      const offset =
        visibleRow().getBoundingClientRect().top - viewport().getBoundingClientRect().top;
      await screen.rerender(view(1_000_000));
      await vi.waitFor(() => {
        expect(visibleRow().dataset.previewRow).toBe(before);
        expect(
          Math.abs(
            visibleRow().getBoundingClientRect().top -
              viewport().getBoundingClientRect().top -
              offset,
          ),
        ).toBeLessThan(Math.max(5, visibleRow().offsetHeight / 29 + 1));
      });
    },
  );

  it("recovers from a failed worker load when its source changes", async () => {
    await using screen = await render(
      <LargeTextViewer name="log.txt" text={"bad\0text"} delimiter={null} />,
    );
    await vi.waitFor(
      () => expect(screen.container.textContent).toContain("This file contains binary data."),
      10_000,
    );
    await screen.rerender(<LargeTextViewer name="log.txt" text="" delimiter={null} />);
    await vi.waitFor(
      () => expect(screen.container.textContent).toContain("This file is empty."),
      10_000,
    );
    expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("reloads a partial page when the indexed row count grows", async () => {
    const load = vi.fn();
    const rows = [["first"]];
    const view = (count: number) => (
      <div style={{ display: "flex", height: 400, width: 600 }}>
        <VirtualTablePreview
          name="log.txt"
          count={count}
          columns={1}
          source
          getRows={() => rows}
          loadPage={load}
        />
      </div>
    );
    await using screen = await render(view(1));
    await vi.waitFor(() => expect(screen.container.textContent).toContain("first"));
    expect(load).not.toHaveBeenCalled();
    await screen.rerender(view(2));
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith(0));
  });
});

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
  ["", "worksheets/./sheet1.xml", false],
  ["x:", "../xl/worksheets/sheet1.xml", false],
  ["", "/xl/worksheets/sheet1.xml", true],
])("preserves %sworksheet metadata with relationship target %s", async (prefix, target, empty) => {
  const { default: JSZip } = await import("jszip");
  const archive = new JSZip();
  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  archive.file(
    "xl/workbook.xml",
    '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet" sheetId="1" r:id="s"/></sheets></workbook>',
  );
  archive.file(
    "xl/_rels/workbook.xml.rels",
    `<Relationships><Relationship Id="s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"/></Relationships>`,
  );
  archive.file(
    "xl/worksheets/sheet1.xml",
    `<${prefix}worksheet xmlns${prefix ? ":x" : ""}="${ns}"><${prefix}dimension ref="XFD1048576"/><${prefix}cols><${prefix}col min="${OFFICE_PREVIEW_MAX_COLUMNS - 1}" max="${OFFICE_PREVIEW_MAX_COLUMNS + 10}" width="20"/><${prefix}col min="${OFFICE_PREVIEW_MAX_COLUMNS + 1}" max="${OFFICE_PREVIEW_MAX_COLUMNS + 30}" hidden="1"/></${prefix}cols><${prefix}sheetData><${prefix}row ht="42" customHeight="1" hidden="1"><${prefix}c r="A50" t="inlineStr"><${prefix}is><${prefix}t>${"value".repeat(1000)}</${prefix}t></${prefix}is></${prefix}c></${prefix}row></${prefix}sheetData><${prefix}mergeCells><${prefix}mergeCell ref="XFD1048576"/></${prefix}mergeCells></${prefix}worksheet>`
      .replace(/<((?:x:)?(?:col|dimension|mergeCell))\b([^>]*)\/>/g, prefix ? "<$1$2></$1>" : "$&")
      .replace(/<sheetData>[\s\S]*?<\/sheetData>/, (data) => (empty ? "<sheetData/>" : data))
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
    const columns = sheet.getElementsByTagNameNS(ns, "col");
    expect(columns).toHaveLength(1);
    expect(columns[0]!.getAttribute("min")).toBe(String(OFFICE_PREVIEW_MAX_COLUMNS - 1));
    expect(columns[0]!.getAttribute("max")).toBe(String(OFFICE_PREVIEW_MAX_COLUMNS));
  } finally {
    worker.terminate();
  }
});

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
