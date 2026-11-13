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

it("toggles a Mermaid attachment between diagram and source through the lazy preview", async () => {
  const text = "flowchart LR\nA --> B";
  const file = new Blob([text], { type: "text/vnd.mermaid" });
  await using screen = await render(
    <AttachmentFilePreview
      name="diagram.mmd"
      mimeType={file.type}
      sizeBytes={file.size}
      file={file}
    />,
  );
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-markdown-mermaid] svg path")).not.toBeNull(),
  );
  await screen.getByRole("button", { name: "Expand diagram" }).click();
  await vi.waitFor(() => {
    const image = document.querySelector<HTMLImageElement>('[role="dialog"] img');
    expect(image?.alt).toBe("Mermaid diagram");
    expect(image?.naturalWidth).toBeGreaterThan(0);
  });
  await page.getByRole("button", { name: "Close image preview" }).click();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  await screen.getByRole("button", { name: "Show Mermaid source" }).click();
  await vi.waitFor(() => expect(screen.container.querySelector("pre")?.textContent).toBe(text));
  await screen.getByRole("button", { name: "Show rendered diagram" }).click();
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-markdown-mermaid] svg path")).not.toBeNull(),
  );
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
});

it("keeps a workspace PDF open across URL renewals and reloads it when the file changes", async () => {
  const { WorkspaceBrowserPreview } = await import("./FilePreviewPanel");
  using _native = vi.spyOn(navigator, "pdfViewerEnabled", "get").mockReturnValue(true);
  const original = URL.createObjectURL(new Blob(["%PDF-1.4"], { type: "application/pdf" }));
  const edited = URL.createObjectURL(new Blob(["%PDF-1.4 edited"], { type: "application/pdf" }));
  const preview = (mutation: string) => (
    <WorkspaceBrowserPreview
      environmentId={EnvironmentId.make("test")}
      threadRef={{ environmentId: EnvironmentId.make("test"), threadId: ThreadId.make("test") }}
      draft={false}
      workspaceRoot="/repo"
      absolutePath="/repo/planning.pdf"
      title="Planning PDF"
      workspaceMutationId={mutation}
    />
  );
  assetUrlState.mockReturnValue({
    _tag: "Success",
    url: `${original}#initial`,
    expiresAt: 0,
    fileRevision: "one",
  });
  try {
    await using screen = await render(preview("first"));
    const opened = screen.container.querySelector("iframe");
    expect(opened?.src.startsWith(original)).toBe(true);

    // An agent command renews the signed URL but leaves the file alone.
    assetUrlState.mockReturnValue({
      _tag: "Success",
      url: `${original}#renewed`,
      expiresAt: 0,
      fileRevision: "one",
    });
    await screen.rerender(preview("second"));
    expect(assetUrlState).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), "second");
    expect(screen.container.querySelector("iframe")).toBe(opened);

    assetUrlState.mockReturnValue({
      _tag: "Success",
      url: edited,
      expiresAt: 0,
      fileRevision: "two",
    });
    await screen.rerender(preview("third"));
    const reloaded = screen.container.querySelector("iframe");
    expect(reloaded).not.toBe(opened);
    expect(reloaded?.src.startsWith(edited)).toBe(true);

    // Servers without revisions hold the preview back until a fresh grant arrives.
    assetUrlState.mockReturnValue({
      _tag: "Success",
      url: `${edited}#stale`,
      expiresAt: 0,
      waiting: true,
    });
    await screen.rerender(preview("fourth"));
    expect(screen.container.querySelector("iframe")).toBeNull();
    assetUrlState.mockReturnValue({ _tag: "Success", url: original, expiresAt: 0 });
    await screen.rerender(preview("fourth"));
    expect(screen.container.querySelector("iframe")?.src.startsWith(original)).toBe(true);
  } finally {
    URL.revokeObjectURL(original);
    URL.revokeObjectURL(edited);
  }
});

it("keeps workspace PDF scroll and zoom after reloads", async () => {
  using fixture = await workspacePdfPreview();
  const { preview, urls } = fixture;
  await using screen = await render(preview(urls.original, "one"));
  await expect.element(screen.getByText("1 / 3 pages", { exact: true })).toBeVisible();
  using workers = vi.spyOn(window, "Worker");
  await screen.getByRole("button", { name: "Next page", exact: true }).click();
  await vi.waitFor(() => expect(screen.container.textContent).toContain("2 / 3 pages"));
  await screen.getByRole("button", { name: "Next page", exact: true }).click();
  await vi.waitFor(() => expect(screen.container.textContent).toContain("3 / 3 pages"));
  for (let index = 0; index < 4; index++) {
    await screen.getByRole("button", { name: "Zoom in", exact: true }).click();
  }
  const { region, offset, scrollTo } = pdfScroll(screen);
  const zoom = screen.container.textContent!.match(/\d+%/)![0];
  const top = region().scrollTop;
  await scrollTo({ top: top + 100, left: 80 });
  await vi.waitFor(() => {
    expect(region().scrollTop).toBeCloseTo(top + 100, 0);
    expect(region().scrollLeft).toBe(80);
  });
  const savedOffset = offset(3);
  await screen.rerender(preview(urls.updated, "two"));
  await expect.element(screen.getByText("3 / 3 pages", { exact: true })).toBeVisible();
  await vi.waitFor(() => {
    expect(screen.container.querySelector('[role="region"]')?.textContent).toContain(
      "Updated budget",
    );
    expect(screen.container.textContent).toContain(zoom);
    expect(region().scrollLeft).toBe(80);
    expect(offset(3)).toBeCloseTo(savedOffset, 0);
  });
  await screen.getByRole("button", { name: "Previous page", exact: true }).click();
  await vi.waitFor(() => expect(screen.container.textContent).toContain("2 / 3 pages"));
  await screen.getByRole("button", { name: "Fit width", exact: true }).click();
  await scrollTo({ top: region().scrollTop + 30 });
  const fitOffset = offset(2);
  await screen.rerender(preview(urls.original, "fit-width"));
  await expect.element(screen.getByText("2 / 3 pages", { exact: true })).toBeVisible();
  await vi.waitFor(() => {
    expect(screen.container.textContent).toContain("Fit width");
    expect(region().scrollLeft).toBe(0);
    expect(offset(2)).toBeCloseTo(fitOffset, 0);
  });
  await screen.getByRole("button", { name: "Previous page", exact: true }).click();
  await vi.waitFor(() => expect(screen.container.textContent).toContain("1 / 3 pages"));
  await screen.getByRole("button", { name: "Zoom in", exact: true }).click();
  const firstPageZoom = screen.container.textContent!.match(/\d+%/)![0];
  await screen.rerender(preview(urls.original, "first-page"));
  await expect.element(screen.getByText("1 / 3 pages", { exact: true })).toBeVisible();
  await vi.waitFor(() => expect(screen.container.textContent).toContain(firstPageZoom));
  await screen.getByRole("button", { name: "Next page", exact: true }).click();
  await vi.waitFor(() => expect(screen.container.textContent).toContain("2 / 3 pages"));
  await screen.rerender(preview(urls.original, "one", "/repo/another.pdf"));
  await expect.element(screen.getByText("1 / 3 pages", { exact: true })).toBeVisible();
  await vi.waitFor(() => {
    expect(screen.container.textContent).toContain("Fit width");
    expect(region().scrollTop).toBe(0);
    expect(region().scrollLeft).toBe(0);
  });
  expect(workers).not.toHaveBeenCalled();
});

it("clamps workspace PDF scroll when pages shrink or disappear", async () => {
  using fixture = await workspacePdfPreview();
  const { preview, urls } = fixture;
  await using screen = await render(preview(urls.original, "one"));
  await expect.element(screen.getByText("1 / 3 pages", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Next page", exact: true }).click();
  await expect.element(screen.getByText("2 / 3 pages", { exact: true })).toBeVisible();
  for (let index = 0; index < 4; index++) {
    await screen.getByRole("button", { name: "Zoom in", exact: true }).click();
  }
  const { region, canvas, offset, scrollTo } = pdfScroll(screen);
  const zoom = screen.container.textContent!.match(/\d+%/)![0];
  const secondPageTop = region().scrollTop;
  await scrollTo({ top: secondPageTop + 600, left: 80 });
  await vi.waitFor(() => expect(region().scrollTop).toBeCloseTo(secondPageTop + 600, 0));
  await screen.rerender(preview(urls.shrunk, "smaller-page"));
  await expect.element(screen.getByText("2 / 3 pages", { exact: true })).toBeVisible();
  await vi.waitFor(() => {
    expect(screen.container.textContent).toContain(zoom);
    expect(region().scrollLeft).toBe(80);
    expect(offset(2)).toBeGreaterThan(0);
    expect(offset(2)).toBeLessThan(canvas(2).getBoundingClientRect().height);
  });
  await screen.rerender(preview(urls.shorter, "three"));
  await expect.element(screen.getByText("2 / 2 pages", { exact: true })).toBeVisible();
  await vi.waitFor(() => {
    expect(screen.container.querySelector('[role="region"]')?.textContent).toContain(
      "Updated milestones",
    );
  });
  await screen.rerender(preview(urls.single, "four"));
  await expect.element(screen.getByText("1 / 1 pages", { exact: true })).toBeVisible();
  await screen.rerender(preview(urls.original, "five"));
  await expect.element(screen.getByText("1 / 3 pages", { exact: true })).toBeVisible();
});

it("unwraps one text attachment without turning off the word wrap setting", async () => {
  const file = new Blob(["a long line"], { type: "text/plain" });
  await using screen = await render(
    <AttachmentFilePreview
      name="notes.txt"
      mimeType={file.type}
      sizeBytes={file.size}
      file={file}
    />,
  );
  await screen.getByRole("button", { name: "Disable word wrap" }).click();
  await expect.element(screen.getByRole("button", { name: "Enable word wrap" })).toBeVisible();
  expect(getClientSettings().wordWrap).toBe(true);
  expect(screen.container.querySelector("pre")?.dataset.wordWrap).toBe("false");
});

it("mounts a bounded set of saved notebook outputs as the reader scrolls", async () => {
  const notebook = {
    nbformat: 4,
    metadata: {},
    cells: Array.from({ length: 20 }, (_, cell) => ({
      cell_type: "code",
      source: [],
      metadata: {},
      outputs: Array.from({ length: 100 }, (_, output) => ({
        output_type: "display_data",
        data: { "text/html": `<p>saved ${cell}-${output}</p>` },
      })),
    })),
  };
  const file = new Blob([JSON.stringify(notebook)]);
  await using screen = await render(
    <div style={{ display: "flex", height: 400, width: 600 }}>
      <AttachmentFilePreview
        name="observations.ipynb"
        mimeType="application/json"
        sizeBytes={file.size}
        file={file}
      />
    </div>,
  );
  // The first outputs wait on the lazy notebook viewer and the conversion worker, not on a frame.
  await vi.waitFor(
    () => expect(screen.container.querySelectorAll("iframe").length).toBeGreaterThan(0),
    { timeout: 10_000 },
  );
  expect(screen.container.querySelectorAll("iframe").length).toBeLessThanOrEqual(16);
  const first = screen.container.querySelector("iframe")!;
  expect(first.srcdoc).toContain("saved 0-0");
  const viewport = screen.container.querySelector<HTMLElement>(".scrollbar-gutter-both")!;
  await act(() => {
    viewport.scrollTop = viewport.scrollHeight;
  });
  await vi.waitFor(() => {
    expect(
      [...screen.container.querySelectorAll("iframe")].some((frame) =>
        frame.srcdoc.includes("saved 19-99"),
      ),
    ).toBe(true);
    expect(first.isConnected).toBe(false);
  });
  expect(screen.container.querySelectorAll("iframe").length).toBeLessThanOrEqual(16);
  await act(() => {
    viewport.scrollTop = 0;
  });
  await vi.waitFor(() =>
    expect(screen.container.querySelector("iframe")?.srcdoc).toContain("saved 0-0"),
  );
});

it.each([
  [String.raw`{\rtf1\uc1\u945{\b bold}Hello}`, "αboldHello"],
  [String.raw`{\rtf1\uc1{\u945}Hello}`, "αHello"],
  [
    String.raw`{\rtf1\ansi{\fonttbl{\f0\fcharset204 Cyrillic;}{\f1\fcharset0 Latin;}}\f0\'c0{\f1\'c0}\'c1}`,
    "АÀБ",
  ],
  [String.raw`{\rtf1\ansi\deff1{\fonttbl{\f1\fcharset204 Cyrillic;}}\'c0\plain\'c1}`, "АБ"],
])("retains RTF grouped Unicode and font text in %s", async (source, expected) => {
  const { openRtf } = await import("./extendedDocumentPreview");
  const result = openRtf(new TextEncoder().encode(source).buffer);
  if (result.type !== "document") throw new Error("Expected rich text document");
  const html = result.pages.map((page) => page.html).join("");
  expect(new DOMParser().parseFromString(html, "text/html").body.textContent).toBe(expected);
});

it.each(["odt", "odp"] as const)("preserves rendered %s spaces and tabs", async (kind) => {
  const archive = new JSZip().file(
    "content.xml",
    `<office:document>${kind === "odt" ? "<office:text>" : "<draw:page>"}<text:p>A<text:s text:c="3"/>B<text:tab/>C</text:p>${kind === "odt" ? "</office:text>" : "</draw:page>"}</office:document>`,
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
      worker.postMessage({ type: "open", kind, bytes }, [bytes]);
    });
    if (result.type !== "document") throw new Error("Expected document");
    await using screen = await render(
      <DocumentPages html={result.pages[0]!.html} name="spacing" output />,
    );
    await vi.waitFor(() => {
      const doc = screen.container.querySelector("iframe")?.contentDocument;
      const spans = doc?.querySelectorAll<HTMLElement>("span[data-odf-whitespace]");
      expect(doc?.querySelector("p")?.textContent).toBe("A   B\tC");
      expect(spans).toHaveLength(2);
      for (const span of spans!) {
        expect(doc!.defaultView!.getComputedStyle(span).whiteSpace).toBe("pre-wrap");
        expect(span.getBoundingClientRect().width).toBeGreaterThan(0);
      }
      expect(spans![0]!.getBoundingClientRect().width).toBeGreaterThan(10);
    });
  } finally {
    worker.terminate();
  }
});

it.each(["rtf", "epub", "ods"] as const)(
  "preserves %s document text through the worker and attachment viewer",
  async (kind) => {
    const archive = new JSZip();
    if (kind === "epub") {
      archive.file(
        "META-INF/container.xml",
        '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
      );
      archive.file(
        "book.opf",
        '<package><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
      );
      archive.file(
        "chapter.xhtml",
        "<html><head><title>Handbook</title></head><body><p>first<br/>second<br/>third</p><hr/></body></html>",
      );
    } else if (kind === "ods") {
      archive.file(
        "content.xml",
        '<office:document><table:table table:name="Forecast"><table:table-row><table:table-cell><text:p>North<office:annotation><text:p>nested note</text:p></office:annotation></text:p><office:annotation><text:p>private note</text:p></office:annotation></table:table-cell><table:table-cell office:value="150"><office:annotation><text:p>revised from 120</text:p></office:annotation></table:table-cell><table:table-cell table:number-columns-repeated="1024"/></table:table-row><table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="1024"/></table:table-row></table:table></office:document>',
      );
    }
    const file =
      kind === "rtf"
        ? new Blob([
            String.raw`{\rtf1\ansi 10\endash 20 \emdash \bullet \lquote a\rquote \ldblquote b\rdblquote\par Name\cell Value\cell\row 12\cell 34\cell\row{\*\private hidden\endash\cell\row}Unicode:\u8211\endash end}`,
          ])
        : await archive.generateAsync({ type: "blob" });
    const bytes = await file.arrayBuffer();
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
        worker.postMessage({ type: "open", kind, bytes }, [bytes]);
      });
      if (kind === "ods") {
        expect(result.type).toBe("ods");
        if (result.type !== "ods") throw new Error("Expected spreadsheet");
        expect(result.sheets[0]!.rows).toEqual([["North", "150"]]);
      } else {
        expect(result.type).toBe("document");
        if (result.type !== "document") throw new Error("Expected document");
        const body = new DOMParser().parseFromString(result.pages[0]!.html, "text/html").body;
        if (kind === "epub") {
          expect(body.querySelectorAll("br")).toHaveLength(2);
          expect(body.querySelectorAll("hr")).toHaveLength(1);
        } else {
          expect(body.textContent).toContain("10–20 —•‘a’“b”");
          expect(body.textContent).toContain("Name\tValue\t12\t34\t");
          expect(body.textContent).toContain("Unicode:–end");
          expect(body.textContent).not.toContain("hidden");
          expect(body.querySelectorAll("br")).toHaveLength(3);
        }
      }
    } finally {
      worker.terminate();
    }
    await using screen = await render(
      <div style={{ display: "flex", height: 400, width: 600 }}>
        <AttachmentFilePreview
          name={`report.${kind}`}
          mimeType="application/octet-stream"
          sizeBytes={file.size}
          file={file}
        />
      </div>,
    );
    await vi.waitFor(
      () => {
        if (kind === "ods") {
          expect(screen.container.textContent).toContain("North");
          expect(screen.container.textContent).toContain("150");
          expect(screen.container.textContent).not.toContain("private note");
          expect(screen.container.textContent).toContain("1 rows · 2 columns");
          expect(screen.container.textContent).not.toContain("Limited to 500");
        } else {
          const frame = screen.container.querySelector("iframe");
          expect(frame?.srcdoc).toContain(kind === "rtf" ? "10–20" : "first<br>second<br>third");
        }
        // The viewer runs its own conversion worker behind lazy chunks.
      },
      { timeout: 10_000 },
    );
    expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  },
);

it.each(["epub", "odt", "ipynb", "html", "encoded-html"] as const)(
  "bounds %s image pixels before returning browser markup",
  async (kind) => {
    const canvas = new OffscreenCanvas(2, 3);
    canvas.getContext("2d");
    const blob = await canvas.convertToBlob({ type: "image/png" });
    for (const width of [2, 12000]) {
      const image = await blob.arrayBuffer();
      new DataView(image).setUint32(16, width);
      new DataView(image).setUint32(20, width === 2 ? 3 : 12000);
      const archive = new JSZip();
      archive.file("cover.png", image);
      if (kind === "epub") {
        archive.file(
          "META-INF/container.xml",
          '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
        );
        archive.file(
          "book.opf",
          '<package><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
        );
        archive.file(
          "chapter.xhtml",
          '<html><body><p>retained caption</p><img src="cover.png"/></body></html>',
        );
      } else
        archive.file(
          "content.xml",
          '<office:document><office:text><text:p>retained caption</text:p><draw:image xlink:href="cover.png"/></office:text></office:document>',
        );
      const base64 = btoa(String.fromCharCode(...new Uint8Array(image)));
      const bytes =
        kind === "ipynb" || kind === "html" || kind === "encoded-html"
          ? new TextEncoder().encode(
              JSON.stringify({
                nbformat: 4,
                cells: [
                  {
                    cell_type: "code",
                    source: "plot()",
                    outputs: [
                      {
                        data: {
                          ...(kind === "html" || kind === "encoded-html"
                            ? {
                                "text/html": `<table><tr><td>retained caption</td></tr></table><img src="${kind === "encoded-html" ? "&#100ata" : "data"}:image/png;base64,${base64}">`,
                              }
                            : { "image/png": base64 }),
                          "text/plain": "retained caption",
                        },
                      },
                    ],
                  },
                ],
              }),
            ).buffer
          : await archive.generateAsync({ type: "arraybuffer" });
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
          worker.postMessage(
            {
              type: "open",
              kind: kind === "html" || kind === "encoded-html" ? "ipynb" : kind,
              bytes,
            },
            [bytes],
          );
        });
        if (result.type === "notebook") {
          const output = result.cells[0]!.outputs[0]!;
          expect(output.kind).toBe(
            width === 2 ? (kind === "html" || kind === "encoded-html" ? "html" : "image") : "text",
          );
          if (output.kind === "html") {
            const rendered = new DOMParser().parseFromString(
              sanitizeDocumentHtml(output.text),
              "text/html",
            );
            expect(rendered.images).toHaveLength(1);
            expect(rendered.querySelector("td")!.textContent).toBe("retained caption");
          }
          if (width !== 2) expect(result.cells[0]!.outputs[0]!.text).toBe("retained caption");
        } else {
          expect(result.type).toBe("document");
          if (result.type !== "document") throw new Error("Expected document");
          expect(result.pages[0]!.html.includes("<img")).toBe(width === 2);
          expect(result.pages[0]!.html).toContain("retained caption");
        }
      } finally {
        worker.terminate();
      }
    }
  },
);

it.each([
  ["standardFontDataUrl", "FoxitSerif.pfb", "standard_fonts"],
  ["cMapUrl", "78-EUC-H.bcmap", "cmaps"],
  ["wasmUrl", "openjpeg.wasm", "wasm"],
])("validates PDF %s assets before decoding", async (kind, filename, directory) => {
  const { BinaryDataFactory } = await import("./pdfDocument");
  const factory = new BinaryDataFactory();
  const fetchAsset = vi.fn(
    async () =>
      new Response("<html>app</html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
  );
  using _fetch = stubGlobal("fetch", fetchAsset);
  await expect(factory.fetch({ kind, filename })).rejects.toThrow(
    `PDF ${directory} asset unavailable.`,
  );
  fetchAsset.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
  await expect(factory.fetch({ kind, filename })).resolves.toEqual(new Uint8Array([1, 2, 3]));
  await expect(factory.fetch({ kind, filename: "missing" })).rejects.toThrow(
    `Unsupported PDF ${directory} asset.`,
  );
});
