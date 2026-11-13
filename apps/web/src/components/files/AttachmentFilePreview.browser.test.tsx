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

describe("bounded binary previews", () => {
  it("preserves length-delimited local and global PAX attributes", async () => {
    const encode = (value: string) => new TextEncoder().encode(value);
    const block = (name: string, content: Uint8Array, type = "0", size = content.length) => {
      const bytes = new Uint8Array(512 + Math.ceil(content.length / 512) * 512);
      const write = (offset: number, value: string) => bytes.set(encode(value), offset);
      write(0, name);
      write(124, size.toString(8).padStart(11, "0") + "\0");
      bytes.fill(32, 148, 156);
      write(156, type);
      write(
        148,
        bytes
          .subarray(0, 512)
          .reduce((sum, byte) => sum + byte, 0)
          .toString(8)
          .padStart(6, "0") + "\0 ",
      );
      bytes.set(content, 512);
      return bytes;
    };
    const attributes = (values: Record<string, string>) =>
      encode(
        Object.entries(values)
          .map(([key, value]) => {
            const payload = ` ${key}=${value}\n`;
            let record = `${encode(payload).length + 1}${payload}`;
            while (encode(record).length !== Number.parseInt(record, 10))
              record = `${encode(record).length}${payload}`;
            return record;
          })
          .join(""),
      );
    const chunks = [
      block("Global", attributes({ size: "5", mtime: "-86400" }), "g"),
      block("Local", attributes({ path: "café\n9 size=1\nname.txt" }), "x"),
      block("first.txt", encode("hello"), "0", 0),
      block("world.txt", encode("world"), "0", 0),
      block("Local", attributes({ size: "3", mtime: "-172800" }), "x"),
      block("short.txt", encode("bye"), "0", 0),
      block("again.txt", encode("again"), "0", 0),
      new Uint8Array(1024),
    ];
    const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const worker = new Worker(new URL("./binaryPreview.worker.ts", import.meta.url), {
      type: "module",
    });
    const request = (input: object) =>
      new Promise<BinaryWorkerResult>((resolve, reject) => {
        worker.addEventListener("message", (event) => resolve(event.data), { once: true });
        worker.addEventListener("error", reject, { once: true });
        worker.postMessage(input, []);
      });
    try {
      const result = await request({
        type: "open",
        kind: "archive",
        name: "pax.tar",
        bytes: bytes.buffer,
      });
      expect(result.type).toBe("archive");
      if (result.type !== "archive") throw new Error("Expected archive");
      expect(result.entries.map((entry) => [entry.path, entry.size, entry.modified])).toEqual([
        ["café\n9 size=1\nname.txt", 5, "1969-12-31T00:00:00.000Z"],
        ["world.txt", 5, "1969-12-31T00:00:00.000Z"],
        ["short.txt", 3, "1969-12-30T00:00:00.000Z"],
        ["again.txt", 5, "1969-12-31T00:00:00.000Z"],
      ]);
      const entry = await request({ type: "entry", path: "café\n9 size=1\nname.txt" });
      if (entry.type !== "entry") throw new Error("Expected entry");
      expect(new TextDecoder().decode(entry.bytes)).toBe("hello");
      expect(entry.bytes.buffer.byteLength).toBe(5);
      entry.bytes[0] = 0;
      const reopened = await request({ type: "entry", path: entry.path });
      if (reopened.type !== "entry") throw new Error("Expected entry");
      expect(new TextDecoder().decode(reopened.bytes)).toBe("hello");
      expect(reopened.bytes.buffer.byteLength).toBe(5);
    } finally {
      worker.terminate();
    }
  });

  it("can leave an archive folder with a repeated separator", async () => {
    const bytes = new Uint8Array(2048);
    const write = (offset: number, value: string) =>
      bytes.set(new TextEncoder().encode(value), offset);
    write(0, "a//hello.txt");
    write(124, "00000000014\0");
    bytes.fill(32, 148, 156);
    write(156, "0");
    write(
      148,
      bytes
        .subarray(0, 512)
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
    );
    write(512, "nested hello");
    const src = URL.createObjectURL(new Blob([bytes]));
    try {
      await using screen = await render(<BinaryViewer src={src} name="paths.tar" kind="archive" />);
      const child = () => screen.container.querySelector<HTMLButtonElement>("tbody button");
      await vi.waitFor(() => expect(child()?.textContent).toBe("a"), 10_000);
      await act(() => child()!.click());
      await act(() => child()!.click());
      await vi.waitFor(() => expect(child()?.textContent).toBe("hello.txt"));
      const parent = () =>
        screen.container.querySelector<HTMLButtonElement>('[aria-label="Parent folder"]')!;
      await act(() => parent().click());
      await act(() => parent().click());
      expect(parent().disabled).toBe(true);
      expect(child()?.textContent).toBe("a");
    } finally {
      URL.revokeObjectURL(src);
    }
  });

  it("uses a PAX size override for the following TAR payload and bounds it", async () => {
    const archive = (size: string) => {
      const header = (name: string, size: number, type: string) => {
        const bytes = new Uint8Array(512);
        const write = (offset: number, value: string) =>
          bytes.set(new TextEncoder().encode(value), offset);
        write(0, name);
        write(124, size.toString(8).padStart(11, "0") + "\0");
        bytes.fill(32, 148, 156);
        write(156, type);
        write(
          148,
          bytes
            .reduce((sum, byte) => sum + byte, 0)
            .toString(8)
            .padStart(6, "0") + "\0 ",
        );
        return bytes;
      };
      const payload = ` size=${size}\n`;
      let record = `${payload.length + 1}${payload}`;
      while (record.length !== Number.parseInt(record, 10)) record = `${record.length}${payload}`;
      const bytes = new Uint8Array(3072);
      bytes.set(header("PaxHeader", record.length, "x"));
      bytes.set(new TextEncoder().encode(record), 512);
      bytes.set(header("hello.txt", 0, "0"), 1024);
      bytes.set(new TextEncoder().encode("hello"), 1536);
      return bytes;
    };
    for (const size of ["5", "999999999999999999999"]) {
      const src = URL.createObjectURL(new Blob([archive(size)]));
      try {
        await using screen = await render(<BinaryViewer src={src} name="pax.tar" kind="archive" />);
        if (size === "5") {
          await vi.waitFor(
            () =>
              expect(screen.container.querySelector("tbody button")?.textContent).toBe("hello.txt"),
            10_000,
          );
          await act(() =>
            screen.container.querySelector<HTMLButtonElement>("tbody button")!.click(),
          );
          await vi.waitFor(
            () => expect(screen.container.querySelector("pre")?.textContent).toBe("hello"),
            10_000,
          );
        } else {
          await vi.waitFor(
            () =>
              expect(screen.container.querySelector('[role="alert"]')?.textContent).toContain(
                "too large or damaged",
              ),
            10_000,
          );
        }
      } finally {
        URL.revokeObjectURL(src);
      }
    }
  });

  it.each([320, 1280])(
    "shows generated SQLite columns and retains picker focus at %i px",
    async (width) => {
      await page.viewport(width, 800);
      const [{ default: initSqlJs }, { default: wasmUrl }] = await Promise.all([
        import("sql.js"),
        import("sql.js/dist/sql-wasm.wasm?url"),
      ]);
      const SQL = await initSqlJs({ locateFile: () => wasmUrl });
      const database = new SQL.Database();
      database.run(
        "CREATE TABLE sqliteData (price INTEGER, quantity INTEGER, total INTEGER GENERATED ALWAYS AS (price * quantity) STORED, doubled INTEGER GENERATED ALWAYS AS (price * 2) VIRTUAL); INSERT INTO sqliteData(price, quantity) VALUES (7, 3); CREATE TABLE zzInventory (stock INTEGER); INSERT INTO zzInventory VALUES(42)",
      );
      const src = URL.createObjectURL(new Blob([new Uint8Array(database.export())]));
      database.close();
      try {
        await using screen = await render(
          <BinaryViewer src={src} name="orders.sqlite" kind="sqlite" />,
        );
        await vi.waitFor(
          () =>
            expect([...screen.container.querySelectorAll("th")].map((x) => x.textContent)).toEqual([
              "price",
              "quantity",
              "total",
              "doubled",
            ]),
          10_000,
        );
        expect([...screen.container.querySelectorAll("td")].map((x) => x.textContent)).toEqual([
          "7",
          "3",
          "21",
          "14",
        ]);
        const trigger = screen.container.querySelector<HTMLButtonElement>('[aria-label="Table"]')!;
        await act(() => trigger.focus());
        await userEvent.keyboard("{Enter}");
        await expect
          .element(page.getByRole("option", { name: "zzInventory (1 rows)" }))
          .toBeVisible();
        await userEvent.keyboard("{ArrowDown}{Enter}");
        await vi.waitFor(() =>
          expect([...screen.container.querySelectorAll("td")].map((x) => x.textContent)).toEqual([
            "42",
          ]),
        );
        await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
        await userEvent.keyboard("{Enter}");
        await expect
          .element(page.getByRole("option", { name: "zzInventory (1 rows)" }))
          .toBeVisible();
        await userEvent.keyboard("{Escape}");
      } finally {
        URL.revokeObjectURL(src);
        await page.viewport(1280, 800);
      }
    },
  );

  it("reauthorizes a failed image when retry is clicked", async () => {
    const image =
      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>';
    refresh
      .mockReset()
      .mockResolvedValueOnce("data:image/png;base64,broken")
      .mockResolvedValue(image);
    await using screen = await render(
      <AttachmentFilePreview
        name="photo.png"
        mimeType="image/png"
        sizeBytes={100}
        asset={{ environmentId: EnvironmentId.make("test-environment"), attachmentId: "image" }}
      />,
    );
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[role="alert"]')?.textContent).toContain(
        "Unable to load image.",
      ),
    );
    await act(() =>
      screen.container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(),
    );
    await vi.waitFor(() =>
      expect(screen.container.querySelector("img")?.getAttribute("src")).toBe(image),
    );
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("reads a small ZIP64 archive and rejects understated directory counts", async () => {
    const zip = new JSZip().file("readme.txt", "hello");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const end = bytes.length - 22;
    const legacy = new DataView(bytes.buffer);
    const extended = new Uint8Array(bytes.length + 76);
    extended.set(bytes.subarray(0, end));
    extended.set(bytes.subarray(end), end + 76);
    const view = new DataView(extended.buffer);
    view.setUint32(end, 0x06064b50, true);
    view.setBigUint64(end + 4, 44n, true);
    view.setBigUint64(end + 24, 1n, true);
    view.setBigUint64(end + 32, 1n, true);
    view.setBigUint64(end + 40, BigInt(legacy.getUint32(end + 12, true)), true);
    view.setBigUint64(end + 48, BigInt(legacy.getUint32(end + 16, true)), true);
    view.setUint32(end + 56, 0x07064b50, true);
    view.setBigUint64(end + 64, BigInt(end), true);
    view.setUint32(end + 72, 1, true);
    view.setUint16(end + 76 + 10, 0xffff, true);
    expect(
      new TextDecoder().decode((await boundedZip(extended.buffer)).get("readme.txt")?.bytes),
    ).toBe("hello");

    const redirected = new Uint8Array(extended.length + 56);
    redirected.set(extended.subarray(0, end + 56));
    redirected.set(extended.subarray(end + 56), end + 112);
    const redirect = new DataView(redirected.buffer);
    redirect.setUint32(end + 56, 0x06064b50, true);
    redirect.setBigUint64(end + 60, 44n, true);
    redirect.setBigUint64(end + 104, BigInt(end), true);
    await expect(boundedZip(redirected.buffer)).rejects.toThrow("Unsupported ZIP64 directory");

    const commented = new Uint8Array(extended.length + 20);
    commented.set(extended);
    const comment = new DataView(commented.buffer);
    comment.setUint16(extended.length - 2, 20, true);
    comment.setUint32(extended.length, 0x07064b50, true);
    comment.setBigUint64(extended.length + 8, BigInt(end), true);
    comment.setUint32(extended.length + 16, 1, true);
    const load = vi.spyOn(JSZip, "loadAsync");
    try {
      await expect(boundedZip(commented.buffer)).rejects.toThrow("Unsupported ZIP64 directory");
      expect(load).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
    }

    const many = new JSZip();
    for (let i = 0; i < 2049; i++) many.file(`file-${i}`, "");
    const crowded = await many.generateAsync({ type: "arraybuffer" });
    new DataView(crowded).setUint16(crowded.byteLength - 12, 1, true);
    await expect(boundedZip(crowded)).rejects.toThrow("more than 2,048 entries");
  });

  it("keeps a file and directory with the same basename accessible", async () => {
    const bytes = await new JSZip()
      .file("foo.txt", "root file")
      .file("foo.txt/bar.txt", "child")
      .generateAsync({ type: "arraybuffer" });
    const src = URL.createObjectURL(new Blob([bytes]));
    try {
      await using screen = await render(<BinaryViewer src={src} name="names.zip" kind="archive" />);
      await vi.waitFor(
        () => expect(screen.container.querySelectorAll("tbody button")).toHaveLength(2),
        10_000,
      );
      const buttons = [...screen.container.querySelectorAll<HTMLButtonElement>("tbody button")];
      expect(buttons.map((button) => button.textContent)).toEqual(["foo.txt", "foo.txt"]);
      await act(() => buttons[1]!.click());
      await vi.waitFor(() => expect(screen.container.textContent).toContain("root file"), 10_000);
    } finally {
      URL.revokeObjectURL(src);
    }
  });

  it("keeps WhiteIsZero TIFF brightness and rejects oversized metadata before decoding", async () => {
    const tags = [
      [256, 2],
      [257, 1],
      [258, 8],
      [259, 1],
      [262, 0],
      [273, 134],
      [277, 1],
      [278, 1],
      [279, 2],
      [284, 1],
    ];
    const bytes = new ArrayBuffer(136);
    const view = new DataView(bytes);
    view.setUint16(0, 0x4949);
    view.setUint16(2, 42, true);
    view.setUint32(4, 8, true);
    view.setUint16(8, tags.length, true);
    tags.forEach(([tag, value], index) => {
      const offset = 10 + index * 12;
      view.setUint16(offset, tag!, true);
      view.setUint16(offset + 2, 4, true);
      view.setUint32(offset + 4, 1, true);
      view.setUint32(offset + 8, value!, true);
    });
    view.setUint8(135, 255);
    const src = URL.createObjectURL(new Blob([bytes]));
    try {
      const blob = await decodeImagePreview(src, false, new AbortController().signal);
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(2, 1);
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      expect([...context.getImageData(0, 0, 2, 1).data]).toEqual([
        255, 255, 255, 255, 0, 0, 0, 255,
      ]);
      bitmap.close();
    } finally {
      URL.revokeObjectURL(src);
    }
    view.setUint32(14, 1_000_000, true);
    const invalid = URL.createObjectURL(new Blob([bytes]));
    try {
      await expect(
        decodeImagePreview(invalid, false, new AbortController().signal),
      ).rejects.toThrow("metadata");
    } finally {
      URL.revokeObjectURL(invalid);
    }
  });
});

describe("large text preview recovery", () => {
  it("retains the workspace viewer across URL renewals and reloads revisions and manual refreshes", async () => {
    const { WorkspaceLargeTextPreview } = await import("./FilePreviewPanel");
    const original = URL.createObjectURL(new Blob(["original\n".repeat(1000)]));
    const changed = URL.createObjectURL(new Blob(["changed\n".repeat(1000)]));
    const workers: Worker[] = [];
    const indexed: Promise<void>[] = [];
    using _worker = stubGlobal(
      "Worker",
      class extends Worker {
        constructor(...args: ConstructorParameters<typeof Worker>) {
          super(...args);
          workers.push(this);
          indexed.push(
            new Promise((resolve) =>
              this.addEventListener("message", (event: MessageEvent<TextPreviewResult>) => {
                if (event.data.type === "meta" && event.data.complete) resolve();
              }),
            ),
          );
        }
      },
    );
    const preview = (mutation: string, key = 0) => (
      <div style={{ display: "flex", flexDirection: "column", height: 400, width: 600 }}>
        <WorkspaceLargeTextPreview
          key={key}
          environmentId={EnvironmentId.make("test")}
          threadRef={{ environmentId: EnvironmentId.make("test"), threadId: ThreadId.make("test") }}
          absolutePath="/repo/large.txt"
          name="large.txt"
          delimiter={null}
          workspaceMutationId={mutation}
          revealLine={null}
          revealRequestId={0}
          wordWrap
        />
      </div>
    );
    const state = (url: string, fileRevision?: string) =>
      assetUrlState.mockReturnValue({
        _tag: "Success",
        url,
        expiresAt: Date.now() + 3_600_000,
        ...(fileRevision === undefined ? {} : { fileRevision }),
      });
    refresh.mockResolvedValue(`${original}#renewed`);
    try {
      state(`${original}#initial`, "one");
      await using screen = await render(preview("first"));
      await vi.waitFor(() => expect(workers).toHaveLength(1));
      await vi.waitFor(() => expect(screen.container.textContent).toContain("original"));
      // A cold worker can take longer than waitFor allows to load and index on CI.
      await indexed[0];
      await vi.waitFor(() => expect(screen.container.textContent).toContain("1,000 lines"));
      const viewport = screen.container.querySelector<HTMLElement>('[tabindex="0"]')!;
      await act(() =>
        viewport.dispatchEvent(
          new WheelEvent("wheel", { deltaY: 250, bubbles: true, cancelable: true }),
        ),
      );
      await vi.waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));
      const scrollTop = viewport.scrollTop;
      state(`${original}#renewed`, "one");
      await screen.rerender(preview("unrelated-command"));
      expect(screen.container.querySelector('[tabindex="0"]')).toBe(viewport);
      expect(viewport.scrollTop).toBe(scrollTop);
      expect(workers).toHaveLength(1);
      state(`${changed}#updated`, "two");
      await screen.rerender(preview("file-edit"));
      // The prefetched first screen paints before the worker starts, so wait for the worker itself.
      await vi.waitFor(() => expect(workers).toHaveLength(2));
      await vi.waitFor(() => expect(screen.container.textContent).toContain("changed"));
      await screen.rerender(preview("file-edit", 1));
      await vi.waitFor(() => expect(workers).toHaveLength(3));
      await vi.waitFor(() => expect(screen.container.textContent).toContain("changed"));
      state(`${original}#legacy`);
      await screen.rerender(preview("legacy-edit", 1));
      await vi.waitFor(() => expect(workers).toHaveLength(4));
      await vi.waitFor(() => expect(screen.container.textContent).toContain("original"));
      assetUrlState.mockReturnValue({ _tag: "Failure" });
      await screen.rerender(preview("legacy-edit", 1));
      expect(screen.container.textContent).toContain("Unable to load file preview.");
      refresh.mockClear();
      refresh.mockImplementation(async () => {
        state(`${changed}#retried`);
        return changed;
      });
      await screen.getByRole("button", { name: "Try again" }).click();
      expect(refresh).toHaveBeenCalledOnce();
      await screen.rerender(preview("legacy-edit", 1));
      await vi.waitFor(() => expect(screen.container.textContent).toContain("changed"));
      expect(screen.container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      URL.revokeObjectURL(original);
      URL.revokeObjectURL(changed);
    }
  });

  it("scrolls within a wrapped row when the row-count track is shorter than the viewport", async () => {
    await using screen = await render(
      <div style={{ display: "flex", height: 400, width: 600 }}>
        <VirtualTablePreview
          name="one.txt"
          count={1}
          columns={1}
          source
          wrap
          getRows={() => [["wrapped source text ".repeat(500)]]}
        />
      </div>,
    );
    const row = () => screen.container.querySelector<HTMLElement>('[data-preview-row="0"]')!;
    const viewport = () => screen.container.querySelector<HTMLElement>('[tabindex="0"]')!;
    await vi.waitFor(() => expect(row()?.offsetHeight).toBeGreaterThan(1000));
    await act(() =>
      viewport().dispatchEvent(
        new WheelEvent("wheel", { deltaY: 150, bubbles: true, cancelable: true }),
      ),
    );
    await vi.waitFor(() => {
      const offset = viewport().getBoundingClientRect().top - row().getBoundingClientRect().top;
      expect(offset).toBeGreaterThan(50);
      expect(offset).toBeLessThan(300);
    });
    await act(() =>
      viewport().dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
    );
    await vi.waitFor(() =>
      expect(
        Math.abs(row().getBoundingClientRect().bottom - viewport().getBoundingClientRect().bottom),
      ).toBeLessThan(2),
    );
    await act(() =>
      viewport().dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })),
    );
    await vi.waitFor(() =>
      expect(row().getBoundingClientRect().top).toBe(viewport().getBoundingClientRect().top),
    );
  });
});
