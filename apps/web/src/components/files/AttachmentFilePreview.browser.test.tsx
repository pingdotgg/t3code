import DocumentPages, { sanitizeDocumentHtml } from "./DocumentPages";
import { act, fakeTimers, render, stubGlobal, type Screen } from "../../../test/render";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

// Prepare the real worker before tests; Vite's worker transform adds a large inline source map.
const { refresh, assetUrlState, pdfOpens, pdfWorkerUrl } = await vi.hoisted(async () => {
  const { default: source } = await import("pdfjs-dist/build/pdf.worker.min.mjs?raw");
  return {
    refresh: vi.fn<() => Promise<string | null>>(),
    assetUrlState: vi.fn<() => import("~/assets/assetUrls").AssetUrlState>(),
    pdfOpens: [] as Array<(task: import("pdfjs-dist").PDFDocumentLoadingTask) => void>,
    pdfWorkerUrl: URL.createObjectURL(new Blob([source], { type: "text/javascript" })),
  };
});

vi.mock(import("pdfjs-dist/build/pdf.worker.min.mjs?url"), () => ({
  default: pdfWorkerUrl,
}));

// Like the real hook, the callback is a new function whenever its resource object is.
const refreshers = new WeakMap<object, () => Promise<string | null>>();
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlRefresh: (_environmentId, resource) => {
    if (!resource) return refresh;
    let callback = refreshers.get(resource);
    if (!callback) refreshers.set(resource, (callback = () => refresh()));
    return callback;
  },
  useAssetUrlState: assetUrlState,
}));
// Hands each document pdf.js opens to the PDF test, which awaits its load instead of a poll window.
vi.mock(import("./pdfDocument"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    openPdf: (bytes) => {
      const task = actual.openPdf(bytes);
      pdfOpens.shift()?.(task);
      return task;
    },
  };
});
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

import { __setClientSettingsForTests, getClientSettings } from "~/hooks/useSettings";
import { AttachmentFilePreview } from "./AttachmentFilePreview";
import LargeTextViewer from "./LargeTextViewer";
import VirtualTablePreview from "./VirtualTablePreview";
import { OfficeFilePreview } from "./OfficeFilePreview";
import { MermaidFilePreview } from "./MermaidFilePreview";
import JSZip from "jszip";
import { boundedZip } from "@t3tools/client-runtime/zip/bounded-zip";
import BinaryViewer from "./BinaryViewer";
import { decodeImagePreview } from "./decodeImagePreview";
import { formatArchiveModifiedDate, type BinaryWorkerResult } from "./binaryPreviewProtocol";
import type { TextPreviewResult } from "./largeTextProtocol";
import type { ReactElement } from "react";
import type { OfficeWorkerRequest, OfficeWorkerResult } from "./officePreviewProtocol";
import { previewErrorText } from "./previewFailureMessages";

// Real worker imports and WASM initialization can exceed waitFor's default second
// when the full browser project runs concurrently on CI.
describe("bounded binary previews", () => {
  it("preserves length-delimited local and global PAX attributes", async () => {
    const encode = (value: string) => new TextEncoder().encode(value);
    const block = (
      name: string,
      content: Uint8Array,
      type = "0",
      size = content.length,
      linkname = "",
    ) => {
      const bytes = new Uint8Array(512 + Math.ceil(content.length / 512) * 512);
      const write = (offset: number, value: string) => bytes.set(encode(value), offset);
      write(0, name);
      write(124, size.toString(8).padStart(11, "0") + "\0");
      bytes.fill(32, 148, 156);
      write(156, type);
      write(157, linkname);
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
      block("Global", attributes({ size: "", mtime: "" }), "g"),
      block("original.txt", encode("hello world")),
      block("alias.txt", encode(""), "1", 0, "original.txt"),
      block("chain.txt", encode(""), "1", 0, "alias.txt"),
      block("Local", attributes({ linkpath: "original.txt" }), "x"),
      block("pax-link.txt", encode(""), "1", 0, "wrong-target"),
      block("LongLink", encode("original.txt\0"), "K"),
      block("gnu-link.txt", encode(""), "1", 0, "wrong-target"),
      block("original.txt", encode("replacement")),
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
        ...[
          "original.txt",
          "alias.txt",
          "chain.txt",
          "pax-link.txt",
          "gnu-link.txt",
          "original.txt",
        ].map((path) => [path, 11, "1970-01-01T00:00:00.000Z"]),
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
      for (const path of ["alias.txt", "chain.txt", "pax-link.txt", "gnu-link.txt"]) {
        const linked = await request({ type: "entry", path });
        if (linked.type !== "entry") throw new Error("Expected hard link entry");
        expect(new TextDecoder().decode(linked.bytes)).toBe("hello world");
      }
      const unresolved = new Uint8Array(
        await new Blob([
          block("missing.txt", encode(""), "1", 0, "nowhere.txt"),
          block("early.txt", encode(""), "1", 0, "later.txt"),
          block("later.txt", encode("hello")),
          block("folder/", encode(""), "5"),
          block("to-folder.txt", encode(""), "1", 0, "folder/"),
          block("replaced.txt", encode("stale")),
          block("replaced.txt", encode(""), "2", 0, "elsewhere.txt"),
          block("to-replaced.txt", encode(""), "1", 0, "replaced.txt"),
          block("Local", attributes({ linkpath: "" }), "x"),
          block("emptied.txt", encode(""), "1", 0, "later.txt"),
          new Uint8Array(1024),
        ]).arrayBuffer(),
      );
      const skipped = await request({
        type: "open",
        kind: "archive",
        name: "links.tar",
        bytes: unresolved.buffer,
      });
      if (skipped.type !== "archive") throw new Error("Expected archive");
      expect(skipped.entries.map((entry) => entry.path)).toEqual([
        "later.txt",
        "folder/",
        "replaced.txt",
      ]);
      expect(await request({ type: "entry", path: "replaced.txt" })).toEqual({
        type: "error",
        code: "archive-entry-unavailable",
        message: "archive-entry-unavailable",
      });
    } finally {
      worker.terminate();
    }
  });

  it("names archive folders whose paths have leading slashes, repeated slashes or ./", async () => {
    const bytes = new Uint8Array(3072);
    const write = (offset: number, value: string) =>
      bytes.set(new TextEncoder().encode(value), offset);
    const member = (offset: number, name: string, content: string) => {
      write(offset, name);
      write(offset + 124, content.length.toString(8).padStart(11, "0") + "\0");
      bytes.fill(32, offset + 148, offset + 156);
      write(offset + 156, "0");
      write(
        offset + 148,
        bytes
          .subarray(offset, offset + 512)
          .reduce((sum, byte) => sum + byte, 0)
          .toString(8)
          .padStart(6, "0") + "\0 ",
      );
      write(offset + 512, content);
    };
    member(0, "/a//hello.txt", "nested hello");
    member(1024, "a/hello.txt", "plain hello");
    // `tar cf x.tar .` names every member from "./".
    member(2048, "./a/dot.txt", "dot hello");
    const src = URL.createObjectURL(new Blob([bytes]));
    try {
      await using screen = await render(<BinaryViewer src={src} name="paths.tar" kind="archive" />);
      const buttons = () => [
        ...screen.container.querySelectorAll<HTMLButtonElement>("tbody button"),
      ];
      const rows = () => buttons().map((button) => button.textContent);
      const back = () =>
        screen.container.querySelector<HTMLButtonElement>('[aria-label="Back to archive"]')!;
      const preview = () => screen.container.querySelector("pre")?.textContent;
      await vi.waitFor(() => expect(rows()).toEqual(["a"]), 10_000);
      await act(() => buttons()[0]!.click());
      await vi.waitFor(() => expect(rows()).toEqual(["dot.txt", "hello.txt", "hello.txt"]));
      await act(() => buttons()[1]!.click());
      await vi.waitFor(() => expect(preview()).toContain("nested hello"), 10_000);
      await act(() => back().click());
      await act(() => buttons()[2]!.click());
      await vi.waitFor(() => expect(preview()).toContain("plain hello"), 10_000);
      await act(() => back().click());
      await act(() => buttons()[0]!.click());
      await vi.waitFor(() => expect(preview()).toContain("dot hello"), 10_000);
      await act(() => back().click());
      await vi.waitFor(() => expect(rows()).toEqual(["dot.txt", "hello.txt", "hello.txt"]));
      const parent = () =>
        screen.container.querySelector<HTMLButtonElement>('[aria-label="Parent folder"]')!;
      await act(() => parent().click());
      expect(parent().disabled).toBe(true);
      expect(rows()).toEqual(["a"]);
    } finally {
      URL.revokeObjectURL(src);
    }
  });

  it("shows 0 bytes for empty archive entries and folders", async () => {
    const zip = new JSZip();
    zip.file("empty.txt", "");
    zip.folder("empty-dir");
    zip.file("pkg/__init__.py", "");
    zip.file("readme.txt", "hello");
    const bytes = await zip.generateAsync({ type: "arraybuffer" });
    const src = URL.createObjectURL(new Blob([bytes]));
    try {
      await using screen = await render(<BinaryViewer src={src} name="sizes.zip" kind="archive" />);
      const rows = () =>
        [...screen.container.querySelectorAll("tbody tr")].map((row) =>
          [...row.querySelectorAll("td")].slice(0, 2).map((cell) => cell.textContent?.trim()),
        );
      await vi.waitFor(() => {
        expect(rows()).toEqual([
          ["empty-dir", "0 bytes"],
          ["pkg", "0 bytes"],
          ["empty.txt", "0 bytes"],
          ["readme.txt", "1 KB"],
        ]);
      }, 10_000);
    } finally {
      URL.revokeObjectURL(src);
    }
  });

  it("dates an archive folder by its own ZIP record when its children come first", async () => {
    const zip = new JSZip();
    const fileDate = new Date("2022-01-02T00:00:00Z");
    zip.file("docs/readme.txt", "a".repeat(1024), { createFolders: false, date: fileDate });
    zip.file("docs/sub/nested.txt", "b".repeat(1024), { createFolders: false, date: fileDate });
    zip.file("docs/", null, { dir: true, date: new Date("2024-10-19T00:00:00Z") });
    zip.file("docs/sub/", null, { dir: true, date: new Date("2023-07-08T00:00:00Z") });
    zip.file("docs/later.txt", "c".repeat(1024), {
      createFolders: false,
      date: new Date("2025-05-06T00:00:00Z"),
    });
    const src = URL.createObjectURL(new Blob([await zip.generateAsync({ type: "arraybuffer" })]));
    try {
      await using screen = await render(<BinaryViewer src={src} name="dates.zip" kind="archive" />);
      await vi.waitFor(() => {
        expect(
          [...screen.container.querySelectorAll("tbody td")].map((cell) =>
            cell.textContent?.trim(),
          ),
        ).toEqual(["docs", "3 KB", formatArchiveModifiedDate("2024-10-19T00:00:00.000")]);
      }, 10_000);
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
          .element(page.getByRole("option", { name: "zzInventory (1 row)" }))
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
          .element(page.getByRole("option", { name: "zzInventory (1 row)" }))
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

  it("keeps WhiteIsZero TIFF brightness and alpha with SubIFDs and type-13 ExifIFD pointers and rejects invalid metadata before decoding", async () => {
    let bytes = new ArrayBuffer(0);
    let exifEntry = 0;
    for (const { pixels, expected } of [
      { pixels: [0, 255], expected: [255, 255, 255, 255, 0, 0, 0, 255] },
      { pixels: [0, 255, 255, 0], expected: [255, 255, 255, 255, 0, 0, 0, 0] },
    ]) {
      const samples = pixels.length / 2;
      const start = samples === 2 ? 170 : 158;
      const exif = start + pixels.length;
      const tags = [
        [256, 2],
        [257, 1],
        [258, 8],
        [259, 1],
        [262, 0],
        [273, start],
        [277, samples],
        [278, 1],
        [279, pixels.length],
        [284, 1],
        [330, 0, 13],
        ...(samples === 2 ? [[338, 2]] : []),
        [34665, exif, 13],
      ];
      exifEntry = 10 + (tags.length - 1) * 12;
      bytes = new ArrayBuffer(exif + 8);
      const view = new DataView(bytes);
      view.setUint16(0, 0x4949);
      view.setUint16(2, 42, true);
      view.setUint32(4, 8, true);
      view.setUint16(8, tags.length, true);
      tags.forEach(([tag, value, type = 4], index) => {
        const offset = 10 + index * 12;
        view.setUint16(offset, tag!, true);
        view.setUint16(offset + 2, type, true);
        view.setUint32(offset + 4, 1, true);
        view.setUint32(offset + 8, value!, true);
      });
      new Uint8Array(bytes, start).set(pixels);
      const src = URL.createObjectURL(new Blob([bytes]));
      try {
        const blob = await decodeImagePreview(src, false, new AbortController().signal);
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(2, 1);
        const context = canvas.getContext("2d")!;
        context.drawImage(bitmap, 0, 0);
        expect([...context.getImageData(0, 0, 2, 1).data]).toEqual(expected);
        bitmap.close();
      } finally {
        URL.revokeObjectURL(src);
      }
    }
    for (const [mutate, message] of [
      [
        (view: DataView) => view.setUint16(exifEntry + 2, 3, true),
        "Invalid TIFF metadata pointer.",
      ],
      [
        (view: DataView) => view.setUint32(exifEntry + 4, 2, true),
        "Invalid TIFF metadata pointer.",
      ],
      [
        (view: DataView) => view.setUint32(14, 1_000_000, true),
        "This TIFF has too much or truncated metadata.",
      ],
    ] as const) {
      const copy = bytes.slice(0);
      mutate(new DataView(copy));
      const invalid = URL.createObjectURL(new Blob([copy]));
      try {
        await expect(
          decodeImagePreview(invalid, false, new AbortController().signal),
        ).rejects.toThrow(message);
      } finally {
        URL.revokeObjectURL(invalid);
      }
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
          draftCwd={null}
          name="large.txt"
          delimiter={null}
          markdownCwd={null}
          copyContents={{ current: null }}
          preview=""
          // Past the highlighted-source cap, so the worker-backed viewer under test renders.
          sizeBytes={128 * 1024 * 1024}
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

  it("keeps row height and vertical position stable across horizontal scroll, fresh row arrays, resize, and typography changes", async () => {
    const columns = 35;
    const header = Array.from({ length: columns }, (_, i) => `Col ${i}`);
    const forcedEightLines = Array.from({ length: 8 }, (_, i) => `L${i + 1}`).join("\n");
    const wrappedTwelveWords = Array.from({ length: 12 }, (_, i) => `segment${i + 1}`).join(" ");
    const makeRows = () => [
      header,
      ...Array.from({ length: 24 }, (_, rowIndex) =>
        Array.from({ length: columns }, (_, columnIndex) => {
          if (rowIndex === 0) {
            if (columnIndex >= 10 && columnIndex < 28) return forcedEightLines;
            if (columnIndex === 34) return wrappedTwelveWords;
          }
          if (columnIndex === 33 && rowIndex % 3 === 1) return forcedEightLines;
          // Wide lowercase glyphs that wrap without spaces or newlines.
          if (rowIndex === 2 && columnIndex === 34) return "m".repeat(11);
          return `r${rowIndex + 1}-c${columnIndex}`;
        }),
      ),
    ];
    const view = (width: number) => (
      <div style={{ display: "flex", height: 320, width }}>
        <VirtualTablePreview
          name="wide-wrapped.csv"
          count={25}
          columns={columns}
          header={header}
          // Fresh arrays per call must not loop or lose measured row heights.
          getRows={(page) => (page === 0 ? makeRows() : undefined)}
        />
      </div>
    );
    const previousSettings = getClientSettings();
    const previousRootFontSize = document.documentElement.style.fontSize;
    try {
      await using screen = await render(view(420));
      const horizontal = () => screen.container.querySelector('[role="table"]')!.parentElement!;
      const vertical = () => screen.container.querySelector<HTMLElement>('[tabindex="0"]')!;
      const row = (index: number) =>
        screen.container.querySelector<HTMLElement>(`[data-preview-row="${index}"]`)!;

      await vi.waitFor(() => {
        expect(row(1)).not.toBeNull();
        expect(row(1).getBoundingClientRect().height).toBeGreaterThan(150);
      });

      const initialRow1Height = row(1).getBoundingClientRect().height;
      const initialRow2Height = row(2).getBoundingClientRect().height;
      const initialRow3Height = row(3).getBoundingClientRect().height;
      const initialRow4Top = row(4).getBoundingClientRect().top;

      // Scroll to the far right where the word-wrapped column 34 mounts after 18 newline cells.
      await act(() => {
        horizontal().scrollLeft = horizontal().scrollWidth;
        horizontal().dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      await vi.waitFor(() => expect(screen.container.textContent).toContain("segment12"));

      expect(Math.abs(row(1).getBoundingClientRect().height - initialRow1Height)).toBeLessThan(1);
      expect(Math.abs(row(2).getBoundingClientRect().height - initialRow2Height)).toBeLessThan(1);
      expect(row(3).getBoundingClientRect().height).toBeGreaterThan(40);
      expect(Math.abs(row(3).getBoundingClientRect().height - initialRow3Height)).toBeLessThan(1);
      expect(Math.abs(row(4).getBoundingClientRect().top - initialRow4Top)).toBeLessThan(1);

      // Scroll vertically into the table, then sweep horizontally back to the left edge.
      await act(() => {
        vertical().scrollTop = 120;
        vertical().dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      await vi.waitFor(() => expect(row(5)).not.toBeNull());
      const scrolledRow5Top = row(5).getBoundingClientRect().top;
      const scrolledRow5Height = row(5).getBoundingClientRect().height;

      await act(() => {
        horizontal().scrollLeft = 0;
        horizontal().dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      await vi.waitFor(() => expect(screen.container.textContent).toContain("r6-c0"));

      expect(Math.abs(row(5).getBoundingClientRect().height - scrolledRow5Height)).toBeLessThan(1);
      expect(Math.abs(row(5).getBoundingClientRect().top - scrolledRow5Top)).toBeLessThan(1);

      // Widening the container widens each uniform column, reducing wrapped line count.
      await screen.rerender(view(1600));
      await vi.waitFor(() =>
        expect(row(1).getBoundingClientRect().height).toBeLessThan(initialRow1Height),
      );
      const widenedRow1Height = row(1).getBoundingClientRect().height;

      // Typography changes invalidate cached minimums even at the same container width.
      await act(() => {
        document.documentElement.style.fontSize = "20px";
        __setClientSettingsForTests({
          ...previousSettings,
          fontSizeInterface: previousSettings.fontSizeInterface + 4,
        });
      });
      await vi.waitFor(() =>
        expect(row(1).getBoundingClientRect().height).toBeGreaterThan(widenedRow1Height),
      );
    } finally {
      document.documentElement.style.fontSize = previousRootFontSize;
      __setClientSettingsForTests(previousSettings);
    }
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

  it.each([
    [1024, false],
    [1025, true],
  ] as const)(
    "shows the column truncation banner only when a CSV exceeds 1,024 columns (%i columns)",
    async (columnCount, truncated) => {
      const row = Array.from({ length: columnCount }, (_, i) => i).join(",");
      await using screen = await render(
        <LargeTextViewer name="wide.csv" text={`${row}\n${row}\n`} delimiter="," />,
      );
      const hasBanner = () =>
        screen.container.textContent?.includes("Showing the first 1,024 columns") ?? false;
      expect(hasBanner()).toBe(truncated);
      const status = () => screen.container.querySelector('[role="status"]')?.textContent ?? "";
      await vi.waitFor(() => expect(status()).toContain("1 row · 1,024 columns"), 10_000);
      expect(hasBanner()).toBe(truncated);
    },
  );

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
describe("standalone Mermaid previews", () => {
  it.each([
    'A@{ "img": "//attacker.invalid/pixel.png" }',
    'A@{ "im\\u0067": "/pixel.png" }',
    "A@{ label: &key img, *key: '/pixel.png' }",
    'A["<img src=//attacker.invalid/pixel.png>"]',
  ])("rejects resource syntax before Mermaid lays out %s", async (node) => {
    using imageSource = vi
      .spyOn(HTMLImageElement.prototype, "src", "set")
      .mockImplementation(() => {});
    await using screen = await render(<MermaidFilePreview text={`flowchart LR\n${node}`} />);
    // The first case loads the Mermaid viewer chunk, which can take over a second on a slow runner.
    await vi.waitFor(
      () =>
        expect(screen.container.querySelector('[role="alert"]')?.textContent).toContain(
          "Show Mermaid source",
        ),
      { timeout: 10_000 },
    );
    expect(imageSource).not.toHaveBeenCalled();
    expect(screen.container.querySelector("svg")).toBeNull();
  });

  it.each(["<-->", "<==>", "<-.->", "-->"])("renders the %s arrow", async (arrow) => {
    await using screen = await render(<MermaidFilePreview text={`flowchart LR\nA ${arrow} B`} />);
    await vi.waitFor(
      () => {
        const diagram = screen.container.querySelector("svg");
        expect(diagram?.querySelector("path")).not.toBeNull();
        expect(diagram?.textContent).toContain("A");
        expect(diagram?.textContent).toContain("B");
      },
      { timeout: 10_000 },
    );
    expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  });
});

it("reloads a workspace Word file after a preview remount", async () => {
  const { default: JSZip } = await import("jszip");
  let heading = "Original outlook";
  using _fetch = stubGlobal(
    "fetch",
    vi.fn(async () => {
      const archive = new JSZip().file(
        "word/document.xml",
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${heading}</w:t></w:r></w:p></w:body></w:document>`,
      );
      return new Response(await archive.generateAsync({ type: "arraybuffer" }));
    }),
  );
  refresh.mockReset().mockResolvedValue("https://example.com/workspace.docx");
  const asset = { environmentId: EnvironmentId.make("test-environment"), attachmentId: "word" };
  await using screen = await render(
    <AttachmentFilePreview
      key="original"
      name="outlook.docx"
      mimeType="application/octet-stream"
      sizeBytes={0}
      asset={asset}
    />,
  );
  await vi.waitFor(() => expect(screen.container.textContent).toContain("Original outlook"), {
    timeout: 10_000,
  });
  heading = "Revised outlook";
  await screen.rerender(
    <AttachmentFilePreview
      key="refreshed"
      name="outlook.docx"
      mimeType="application/octet-stream"
      sizeBytes={0}
      asset={asset}
    />,
  );
  await vi.waitFor(() => expect(screen.container.textContent).toContain("Revised outlook"), {
    timeout: 10_000,
  });
  expect(screen.container.textContent).not.toContain("Original outlook");
});

it("clears an Office metadata error when the same URL becomes previewable", async () => {
  const src = "data:application/octet-stream,invalid-office-file";
  let resolveBody!: (body: string) => void;
  const body = new Promise<string>((resolve) => {
    resolveBody = resolve;
  });
  using _fetch = stubGlobal(
    "fetch",
    vi.fn(() => body.then((text) => new Response(text))),
  );
  await using screen = await render(
    <OfficeFilePreview src={src} name="report.docx" kind="docx" sizeBytes={51 * 1024 * 1024} />,
  );
  await vi.waitFor(() => expect(screen.container.textContent).toContain("under 50 MB"));
  await screen.rerender(
    <OfficeFilePreview src={src} name="report.docx" kind="docx" sizeBytes={100} />,
  );
  await vi.waitFor(() =>
    expect(screen.container.querySelector('[aria-label="Loading file"]')).not.toBeNull(),
  );
  expect(screen.container.textContent).not.toContain("under 50 MB");
  resolveBody("invalid-office-file");
  await vi.waitFor(() => expect(screen.container.textContent).toContain("not a readable ZIP"), {
    timeout: 10_000,
  });
});

describe("attachment HTML preview recovery", () => {
  const originalUrl = "data:text/html,original";
  const renewedUrl = "data:text/html,renewed";

  function setup() {
    refresh.mockReset().mockResolvedValueOnce(originalUrl).mockResolvedValue(renewedUrl);
  }

  const openRemote = () =>
    render(
      <AttachmentFilePreview
        name="document.html"
        mimeType="text/html"
        sizeBytes={100}
        asset={{ environmentId: EnvironmentId.make("test-environment"), attachmentId: "html" }}
      />,
    );

  const toggleMode = async (screen: Screen, label: string) => {
    const button = screen.container.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    );
    expect(button, label).not.toBeNull();
    await act(async () => button!.click());
  };
  const alert = (screen: Screen) => screen.container.querySelector('[role="alert"]');
  // The app's connection runtime keeps polling environment discovery through the same global
  // fetch while these tests run, so only the attachment's own requests are counted.
  const attachmentFetches = () =>
    vi
      .mocked(fetch)
      .mock.calls.map(([url]) => url)
      .filter((url) => typeof url === "string" && url.startsWith("data:text/html"));

  it("keeps a renewed URL for subsequent rendered and source views", async () => {
    setup();
    let now = 0;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
    using _fetch = stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<p>Captured HTML</p>")),
    );
    await using screen = await openRemote();
    expect(screen.container.querySelector("iframe")?.getAttribute("src")).toBe(originalUrl);
    now = 61 * 60_000;
    await toggleMode(screen, "Show HTML source");
    await act(async () => {
      await import("./ReadOnlySourcePreview");
    });
    expect(attachmentFetches()).toEqual([renewedUrl]);
    await vi.waitFor(() =>
      expect(screen.container.querySelector("pre")?.textContent).toBe("<p>Captured HTML</p>"),
    );

    await toggleMode(screen, "Show rendered page");
    expect(screen.container.querySelector("iframe")?.getAttribute("src")).toBe(renewedUrl);
    await toggleMode(screen, "Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(attachmentFetches()).toEqual([renewedUrl, renewedUrl]);
  });

  it("does not fetch or mark an expired URL fresh when reauthorization is unavailable", async () => {
    setup();
    let now = 0;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
    using _fetch = stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<p>Captured HTML</p>")),
    );
    await using screen = await openRemote();
    now = 61 * 60_000;
    refresh.mockResolvedValue(null);
    await toggleMode(screen, "Show HTML source");
    expect(attachmentFetches()).toEqual([]);
    expect(alert(screen)?.textContent).toContain("Reconnect to the environment and try again.");

    await toggleMode(screen, "Show rendered page");
    await toggleMode(screen, "Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(attachmentFetches()).toEqual([]);
  });

  it("can return to rendered HTML after local source decoding fails", async () => {
    setup();
    let now = 0;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
    using _fetch = stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<p>Captured HTML</p>")),
    );
    const file = new Blob([new Uint8Array([0x3c, 0x70, 0x3e, 0xe9])], { type: "text/html" });
    await using screen = await render(
      <AttachmentFilePreview
        name="document.html"
        mimeType="text/html"
        sizeBytes={file.size}
        file={file}
      />,
    );
    await toggleMode(screen, "Show HTML source");
    await vi.waitFor(() => expect(alert(screen)?.textContent).toContain("not UTF-8"));

    await toggleMode(screen, "Show rendered page");
    expect(alert(screen)).toBeNull();
    expect(screen.container.querySelector("iframe")?.title).toBe("document.html");
  });
});

describe("document output sanitization", () => {
  it("fits saved HTML outputs to their content and resizes when the content changes", async () => {
    await using screen = await render(
      <DocumentPages html="<table><tr><td>42</td></tr></table>" name="Output" output />,
    );
    const frame = screen.container.querySelector("iframe")!;
    await vi.waitFor(() => {
      expect(frame.contentDocument?.querySelector("td")?.textContent).toBe("42");
      expect(frame.clientHeight).toBeGreaterThan(32);
      expect(frame.clientHeight).toBeLessThan(120);
    });
    const initialHeight = frame.clientHeight;
    await screen.rerender(
      <DocumentPages html={"<p>More saved output</p>".repeat(10)} name="Output" output />,
    );
    await vi.waitFor(() => {
      expect(frame.contentDocument?.querySelectorAll("p")).toHaveLength(10);
      expect(frame.clientHeight).toBeGreaterThan(initialHeight);
      expect(frame.contentDocument!.body.scrollHeight).toBeLessThanOrEqual(frame.clientHeight);
    });
  });

  it("preserves table content and raster data while removing scripts and network resources", () => {
    const html = sanitizeDocumentHtml(
      '<script>alert(1)</script><style>@import "https://example.com/style.css";</style><iframe src="https://example.com"></iframe><img src="https://example.com/tracker.png" onerror="alert(1)"><img src="data:image/png;base64,iVBORw0KGgo="><table><tr><td>Research</td></tr></table><a href="https://example.com">Results</a>',
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector("td")?.textContent).toBe("Research");
    expect(doc.images).toHaveLength(1);
    expect(doc.images[0]!.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(doc.querySelector("script,style,iframe,a,[onerror]")).toBeNull();
    expect(html).not.toContain("https://");
  });
});
it("keeps an attachment URL when the parent passes a fresh asset object for the same attachment", async () => {
  const url = URL.createObjectURL(new Blob(["%PDF-1.4"], { type: "application/pdf" }));
  refresh.mockReset().mockResolvedValue(url);
  const preview = () => (
    <AttachmentFilePreview
      name="report.pdf"
      mimeType="application/pdf"
      sizeBytes={8}
      asset={{ environmentId: EnvironmentId.make("test"), attachmentId: "report" }}
    />
  );
  try {
    await using screen = await render(preview());
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    // FilePreviewPanel rebuilds `asset` when an agent command completes.
    await screen.rerender(preview());
    expect(refresh).toHaveBeenCalledTimes(1);
  } finally {
    URL.revokeObjectURL(url);
  }
});

it("opens a known empty attachment even when its range response is inaccessible", async () => {
  refresh.mockResolvedValue("https://unreachable.invalid/empty.txt");
  await using screen = await render(
    <AttachmentFilePreview
      name="empty.txt"
      mimeType="text/plain"
      sizeBytes={0}
      asset={{ environmentId: EnvironmentId.make("test"), attachmentId: "empty" }}
    />,
  );
  await vi.waitFor(
    () => expect(screen.container.textContent).toContain("This file is empty."),
    10_000,
  );
});

it.each(["draft", "thread"] as const)(
  "reads an unknown-size %s workspace file instead of treating it as empty",
  async (source) => {
    refresh.mockResolvedValue("https://example.test/binary.txt");
    using _fetch = stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid\0text")),
    );
    await using screen = await render(
      <AttachmentFilePreview
        name="binary.txt"
        mimeType="application/octet-stream"
        sizeBytes={0}
        asset={{
          environmentId: EnvironmentId.make("test"),
          resource:
            source === "draft"
              ? { _tag: "draft-workspace-file", cwd: "/repo", path: "/repo/binary.txt" }
              : { _tag: "media-file", threadId: ThreadId.make("test"), path: "/repo/binary.txt" },
        }}
      />,
    );
    await vi.waitFor(() =>
      expect(screen.container.textContent).toContain(
        "This file contains binary data and cannot be shown as text.",
      ),
    );
    expect(fetch).toHaveBeenCalled();
    expect(screen.container.textContent).not.toContain("This file is empty.");
  },
);

it("refreshes authorization and retries a failed streamed attachment", async () => {
  const bad = URL.createObjectURL(new Blob(["invalid\0text"]));
  const good = URL.createObjectURL(new Blob(["recovered text\n"]));
  refresh.mockReset().mockResolvedValueOnce(bad).mockResolvedValue(good);
  try {
    await using screen = await render(
      <AttachmentFilePreview
        name="retry.txt"
        mimeType="text/plain"
        sizeBytes={2_000_000}
        asset={{ environmentId: EnvironmentId.make("test"), attachmentId: "retry" }}
      />,
    );
    // A cold large-text worker can take longer than waitFor's default to boot on CI.
    await vi.waitFor(
      () => expect(screen.container.textContent).toContain("This file contains binary data."),
      { timeout: 10_000 },
    );
    await act(() =>
      screen.container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(),
    );
    await vi.waitFor(() => expect(screen.container.textContent).toContain("recovered text"));
    expect(refresh).toHaveBeenCalledTimes(2);
  } finally {
    URL.revokeObjectURL(bad);
    URL.revokeObjectURL(good);
  }
});

it.each([
  ["custom/sheet1.xml", 250001],
  ["/xl/custom/sheet1.bin", 250001],
  ["custom/valid.xml", 1],
] as const)(
  "bounds the worksheet relationship target %s at row %i before the reader allocates its grid",
  async (target, row) => {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file(
      "xl/workbook.xml",
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet" sheetId="1" r:id="rId1"/></sheets></workbook>',
    );
    zip.file(
      "xl/_rels/workbook.xml.rels",
      `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"/></Relationships>`,
    );
    zip.file(
      target.startsWith("/") ? target.slice(1) : `xl/${target}`,
      `<worksheet><sheetData><row r="${row}"><c r="A${row}" t="inlineStr"><is><t>worksheet value</t></is></c></row></sheetData></worksheet>`,
    );
    const bytes = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
    const { prepareOffice } = await import("./officeArchive");
    if (row > 250000) {
      await expect(
        prepareOffice(bytes, "xlsx").catch((cause: unknown) => previewErrorText(cause, "")),
      ).resolves.toContain("This workbook exceeds the preview limit");
      return;
    }
    const prepared = await prepareOffice(bytes, "xlsx");
    const bounded = await JSZip.loadAsync(prepared.bytes);
    expect(await bounded.file(`xl/${target}`)!.async("string")).toContain("worksheet value");
  },
);

it("copies every indexed line rather than the mounted preview rows", async () => {
  const text = Array.from({ length: 10_000 }, (_, i) => `line-${i}`).join("\n");
  const copyContents = { current: null as (() => Promise<string>) | null };
  await using screen = await render(
    <LargeTextViewer name="whole.txt" text={text} delimiter={null} copyContents={copyContents} />,
  );
  await vi.waitFor(() => expect(screen.container.textContent).toContain("line-0"));
  // Copy rejects until the worker finishes indexing, which a cold worker can delay past waitFor's default on CI.
  await vi.waitFor(async () => expect(await copyContents.current!()).toBe(text), {
    timeout: 10_000,
  });
  const first = copyContents.current!();
  await expect(copyContents.current!()).rejects.toThrow("Another copy is in progress.");
  expect(await first).toBe(text);
  expect(await copyContents.current!()).toBe(text);
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
});

it.each([
  ["one.csv", "text/csv", "name\nAda\n", "1 row · 1 column ·"],
  ["two.csv", "text/csv", "name,count\nAda,1\nGrace,2\n", "2 rows · 2 columns ·"],
  ["one.tsv", "text/tab-separated-values", "name\nAda\n", "1 row · 1 column ·"],
  ["one.txt", "text/plain", "a".repeat(1024 * 1024) + "\n", "1 line ·"],
  ["two.txt", "text/plain", ("a".repeat(512 * 1024) + "\n").repeat(2), "2 lines ·"],
] as const)("labels the counts of %s in the status line", async (name, mimeType, text, label) => {
  const file = new Blob([text], { type: mimeType });
  await using screen = await render(
    <AttachmentFilePreview name={name} mimeType={mimeType} sizeBytes={file.size} file={file} />,
  );
  const status = () => screen.container.querySelector('[role="status"]')?.textContent ?? "";
  // A cold large-text worker can take longer than waitFor's default to boot on CI.
  await vi.waitFor(() => expect(status()).toMatch(/ [KM]?B$/), { timeout: 10_000 });
  expect(status()).toContain(label);
});

it.each(["archive", "sqlite"] as const)(
  "reauthorizes and retries a failed %s attachment",
  async (kind) => {
    const bad = URL.createObjectURL(new Blob(["invalid"]));
    let bytes: Uint8Array<ArrayBuffer>;
    if (kind === "archive")
      bytes = new Uint8Array(
        await new JSZip().file("recovered.txt", "ok").generateAsync({ type: "uint8array" }),
      );
    else {
      const [{ default: initSqlJs }, { default: wasmUrl }] = await Promise.all([
        import("sql.js"),
        import("sql.js/dist/sql-wasm.wasm?url"),
      ]);
      const SQL = await initSqlJs({ locateFile: () => wasmUrl });
      const database = new SQL.Database();
      database.run(
        "CREATE TABLE recovered (value TEXT); INSERT INTO recovered VALUES('retry succeeded')",
      );
      bytes = new Uint8Array(database.export());
      database.close();
    }
    const good = URL.createObjectURL(new Blob([bytes]));
    refresh.mockReset().mockResolvedValueOnce(bad).mockResolvedValue(good);
    try {
      await using screen = await render(
        <AttachmentFilePreview
          name={kind === "archive" ? "retry.zip" : "retry.sqlite"}
          mimeType="application/octet-stream"
          sizeBytes={bytes.length}
          asset={{ environmentId: EnvironmentId.make("test"), attachmentId: "retry" }}
        />,
      );
      await vi.waitFor(
        () => expect(screen.container.querySelector('[role="alert"] button')).not.toBeNull(),
        10_000,
      );
      await act(() =>
        screen.container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(),
      );
      await vi.waitFor(
        () =>
          expect(screen.container.textContent).toContain(
            kind === "archive" ? "recovered.txt" : "retry succeeded",
          ),
        10_000,
      );
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      URL.revokeObjectURL(bad);
      URL.revokeObjectURL(good);
    }
  },
);

it("loads a font attachment through the lazy preview", async () => {
  const { loadBundledFontBytes, resolveBundledFamilyFace } = await import("@betteroffice/fonts");
  const bytes = await loadBundledFontBytes(resolveBundledFamilyFace("Carlito", false, false)!);
  const file = new Blob([bytes], { type: "font/ttf" });
  await using screen = await render(
    <AttachmentFilePreview
      name="Carlito.ttf"
      mimeType="font/ttf"
      sizeBytes={file.size}
      file={file}
    />,
  );
  // Two cold lazy chunks plus decoding a 600 KB font can take longer than waitFor's default on CI.
  await vi.waitFor(
    () => {
      const frame = screen.container.querySelector("iframe");
      expect(frame?.title).toBe("Carlito.ttf");
      expect(frame?.srcdoc).toContain("@font-face");
      expect(frame?.srcdoc).toContain("The quick brown fox");
    },
    { timeout: 10_000 },
  );
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
});

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

it("loads an edited HTML file outside the workspace from a renewed URL", async () => {
  const { WorkspaceBrowserPreview } = await import("./FilePreviewPanel");
  const preview = (mutation: string) => (
    <WorkspaceBrowserPreview
      environmentId={EnvironmentId.make("test")}
      threadRef={{ environmentId: EnvironmentId.make("test"), threadId: ThreadId.make("test") }}
      draft={false}
      workspaceRoot="/repo"
      absolutePath="/tmp/report.html"
      title="Report"
      workspaceMutationId={mutation}
    />
  );
  assetUrlState.mockReturnValue({ _tag: "Success", url: "data:text/html,original", expiresAt: 0 });
  await using screen = await render(preview("first"));
  const opened = screen.container.querySelector("iframe");
  expect(opened?.getAttribute("src")).toMatch(/^data:text\/html,original/);

  assetUrlState.mockReturnValue({
    _tag: "Success",
    url: "data:text/html,original",
    expiresAt: 0,
    waiting: true,
  });
  await screen.rerender(preview("second"));
  expect(assetUrlState).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), "second");
  expect(screen.container.querySelector("iframe")).toBe(opened);

  assetUrlState.mockReturnValue({ _tag: "Success", url: "data:text/html,edited", expiresAt: 0 });
  await screen.rerender(preview("second"));
  expect(screen.container.querySelector("iframe")?.getAttribute("src")).toMatch(
    /^data:text\/html,edited/,
  );
});

it("keeps an unchanged workspace HTML page loaded across commands and renews its grant", async () => {
  const { WorkspaceBrowserPreview } = await import("./FilePreviewPanel");
  const preview = (mutation: string) => (
    <WorkspaceBrowserPreview
      environmentId={EnvironmentId.make("test")}
      threadRef={{ environmentId: EnvironmentId.make("test"), threadId: ThreadId.make("test") }}
      draft={false}
      workspaceRoot="/repo"
      absolutePath="/repo/report.html"
      title="Report"
      workspaceMutationId={mutation}
    />
  );
  const minted = (url: string, fileRevision: string, expiresAt: number) =>
    assetUrlState.mockReturnValue({ _tag: "Success", url, expiresAt, fileRevision });
  const shownSrc = (screen: Screen) =>
    screen.container.querySelector("iframe")?.getAttribute("src");
  refresh.mockReset();
  using _timers = fakeTimers();
  vi.setSystemTime(0);
  const expiresAt = 60 * 60_000;
  minted("data:text/html,original", "one", expiresAt);
  await using screen = await render(preview("first"));
  const opened = screen.container.querySelector("iframe");
  expect(shownSrc(screen)).toMatch(/^data:text\/html,original/);

  // Agent commands re-mint the URL; the page and everything it loaded are unchanged.
  minted("data:text/html,renewed", "one", expiresAt + 30 * 60_000);
  await screen.rerender(preview("second"));
  await screen.rerender(preview("third"));
  expect(screen.container.querySelector("iframe")).toBe(opened);
  expect(shownSrc(screen)).toMatch(/^data:text\/html,original/);
  expect(refresh).not.toHaveBeenCalled();

  // Its grant is about to expire, so the page moves to the URL minted since.
  await act(() => vi.advanceTimersByTime(59 * 60_000));
  expect(shownSrc(screen)).toMatch(/^data:text\/html,renewed/);
  expect(refresh).not.toHaveBeenCalled();

  // With no command since, the page asks for a fresh URL itself and moves to it.
  refresh.mockResolvedValue(null);
  await act(() => vi.advanceTimersByTime(30 * 60_000));
  expect(refresh).toHaveBeenCalledTimes(1);
  minted("data:text/html,renewed-again", "one", expiresAt + 90 * 60_000);
  await screen.rerender(preview("third"));
  expect(shownSrc(screen)).toMatch(/^data:text\/html,renewed-again/);

  minted("data:text/html,edited", "two", expiresAt + 90 * 60_000);
  await screen.rerender(preview("fourth"));
  expect(shownSrc(screen)).toMatch(/^data:text\/html,edited/);
});

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

// Resolves once pdf.js has parsed the next document and every page size the viewer reads.
function nextPdfLoad() {
  return new Promise<import("pdfjs-dist").PDFDocumentLoadingTask>((resolve) =>
    pdfOpens.push(resolve),
  ).then(async (task) => {
    const document = await task.promise;
    await Promise.all(
      Array.from({ length: document.numPages }, (_, index) => document.getPage(index + 1)),
    );
  });
}

it("keeps a workspace PDF's page, offset and zoom when a new revision reloads it", async () => {
  assetUrlState.mockReset();
  pdfOpens.length = 0;
  const { WorkspaceBrowserPreview } = await import("./FilePreviewPanel");
  using _native = vi.spyOn(navigator, "pdfViewerEnabled", "get").mockReturnValue(false);
  const original = URL.createObjectURL(planningPdf());
  // A taller first page moves page 2, so only a page-relative restore lands on the same spot.
  const updated = URL.createObjectURL(
    planningPdf(["Quarterly outlook", "Delivery milestones", "Updated budget"], 500),
  );
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
          threadRef={{
            environmentId: EnvironmentId.make("test"),
            threadId: ThreadId.make(original),
          }}
          draft={false}
          absolutePath={path}
          workspaceRoot="/repo"
          title="Planning PDF"
          workspaceMutationId={mutation}
        />
      </div>
    );
  };
  const reload = async (screen: Screen, element: ReactElement) => {
    const loaded = nextPdfLoad();
    await screen.rerender(element);
    await loaded;
  };
  try {
    const loaded = nextPdfLoad();
    await using screen = await render(preview(original, "one"));
    await loaded;
    await expect.element(screen.getByText("1 / 3 pages", { exact: true })).toBeVisible();
    using workers = vi.spyOn(window, "Worker");
    const region = () => screen.getByRole("region", { name: "Planning PDF" }).element();
    const offset = () =>
      region().getBoundingClientRect().top -
      region().querySelector('canvas[aria-label="Page 2"]')!.getBoundingClientRect().top;
    await screen.getByRole("button", { name: "Zoom in", exact: true }).click();
    await screen.getByRole("button", { name: "Next page", exact: true }).click();
    await expect.element(screen.getByText("2 / 3 pages", { exact: true })).toBeVisible();
    const zoom = screen.container.textContent!.match(/\d+%/)![0];
    const top = region().scrollTop + 100;
    await act(async () => {
      const scrolled = new Promise((resolve) =>
        region().addEventListener("scroll", resolve, { once: true }),
      );
      region().scrollTo({ top, left: 80 });
      await scrolled;
    });
    const savedOffset = offset();

    await reload(screen, preview(updated, "two"));
    await expect.element(screen.getByText("2 / 3 pages", { exact: true })).toBeVisible();
    expect(screen.container.textContent).toContain(zoom);
    expect(region().scrollLeft).toBe(80);
    expect(offset()).toBeCloseTo(savedOffset, 0);
    expect(workers).not.toHaveBeenCalled();

    await reload(screen, preview(updated, "two", "/repo/another.pdf"));
    await expect.element(screen.getByText("1 / 3 pages", { exact: true })).toBeVisible();
    expect(screen.container.textContent).toContain("Fit width");
    expect(region().scrollTop).toBe(0);
  } finally {
    URL.revokeObjectURL(original);
    URL.revokeObjectURL(updated);
  }
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
  const firstOutput = first.parentElement!;
  expect(first.srcdoc).toContain("saved 0-0");
  await vi.waitFor(() => expect(first.clientHeight).toBeGreaterThan(0));
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
  const reservedHeight = firstOutput.getBoundingClientRect().height;
  using cleanup = new DisposableStack();
  const pending = new AbortController();
  cleanup.defer(() => pending.abort());
  // Hold the remounted frame in its loading state until it scrolls away again.
  firstOutput.addEventListener("load", (event) => event.stopPropagation(), {
    capture: true,
    signal: pending.signal,
  });
  await act(() => {
    viewport.scrollTop = 0;
  });
  await vi.waitFor(() => {
    expect(firstOutput.querySelector("iframe")?.srcdoc).toContain("saved 0-0");
    expect(firstOutput.getBoundingClientRect().height).toBe(reservedHeight);
  });
  await act(() => {
    viewport.scrollTop = viewport.scrollHeight;
  });
  await vi.waitFor(() => expect(firstOutput.querySelector("iframe")).toBeNull());
  expect(firstOutput.getBoundingClientRect().height).toBe(reservedHeight);
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

function officeWorkerReply(
  worker: Worker,
  request: OfficeWorkerRequest,
  transfer: Transferable[] = [],
) {
  const response = new Promise<OfficeWorkerResult>((resolve) =>
    worker.addEventListener(
      "message",
      (event: MessageEvent<OfficeWorkerResult>) => resolve(event.data),
      { once: true },
    ),
  );
  worker.postMessage(request, transfer);
  return response;
}

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
      const result = await officeWorkerReply(worker, { type: "open", kind, bytes }, [bytes]);
      if (kind === "ods") {
        expect(result.type).toBe("ods");
        if (result.type !== "ods") throw new Error("Expected spreadsheet");
        expect(result.sheets[0]!.rows).toEqual([["North", "150"]]);
      } else if (kind !== "epub") {
        expect(result.type).toBe("document");
        if (result.type !== "document") throw new Error("Expected document");
        const body = new DOMParser().parseFromString(result.pages[0]!.html, "text/html").body;
        expect(body.textContent).toContain("10–20 —•‘a’“b”");
        expect(body.textContent).toContain("Name\tValue\t12\t34\t");
        expect(body.textContent).toContain("Unicode:–end");
        expect(body.textContent).not.toContain("hidden");
        expect(body.querySelectorAll("br")).toHaveLength(3);
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
          expect(screen.container.textContent).toContain("1 row · 2 columns");
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

it("renders EPUB publisher styles and follows an anchored link to a fixed-layout section", async () => {
  const archive = new JSZip()
    .file("META-INF/container.xml", '<container><rootfile full-path="OPS/book.opf"/></container>')
    .file(
      "OPS/book.opf",
      `<package xmlns="http://www.idpf.org/2007/opf">
      <manifest>
        <item id="front" href="front.xhtml" media-type="application/xhtml+xml"/>
        <item id="art" href="art.xhtml" media-type="application/xhtml+xml"/>
        <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        <item id="poster" href="illustration.svg" media-type="image/svg+xml"/>
      </manifest>
      <spine page-progression-direction="rtl">
        <itemref idref="front"/><itemref idref="art" properties="rendition:layout-pre-paginated"/>
        <itemref idref="poster"/>
      </spine>
    </package>`,
    )
    .file(
      "OPS/nav.xhtml",
      `<html xmlns:epub="http://www.idpf.org/2007/ops"><body>
      <nav epub:type="toc"><ol><li><a href="art.xhtml#figure">Illustration</a></li></ol></nav>
    </body></html>`,
    )
    .file(
      "OPS/front.xhtml",
      `<!DOCTYPE html []><html xmlns:epub="http://www.idpf.org/2007/ops"><head>
      <link rel="stylesheet" href="styles/book.css"/>
    </head><body dir="rtl"><section epub:type="chapter">
      <p id="opening"><span id="pagebreak"/>Opening</p><pre>
      <code>npm test</code></pre><a href="art.xhtml#figure">See illustration</a>
      <a href="https://example.invalid/">External</a><a href="javascript:alert(1)">Unsafe</a><a href="ftp://example.invalid/book">Legacy link</a>
      <p id="caption"><a href="#opening"><big>Figure</big> <a href="art.xhtml#figure">See table</a> for details.</a></p>
      <math xmlns="http://www.w3.org/1998/Math/MathML"><mfrac><mi>x</mi><mn>2</mn></mfrac></math>
      <math xmlns="http://www.w3.org/1998/Math/MathML"><mfenced id="interval" open="[" close="]" separators=" ; "><mi>a</mi>
        <mi>b</mi><mi>c</mi></mfenced></math>
      <math xmlns="http://www.w3.org/1998/Math/MathML"><mfenced id="tuple" open="⟨" close="⟩"><mi>x</mi></mfenced></math>
      <video autoplay=""></video><video preload="metadata"></video>
      <object id="illustrated-object" type="image/svg+xml" data="illustration.svg" width="200" height="100">Illustration</object>
      <object type="application/x-example" data="illustration.svg"><p id="object-fallback">Fallback text</p></object>
      <form id="workbook" action="https://example.invalid/submit" onsubmit="return false">
        <fieldset><legend>Worksheet</legend>
          <label for="answer">Answer</label><input id="answer" type="checkbox" checked="" autofocus=""/>
          <textarea rows="5" cols="30">\nExample</textarea>
          <select><option>First</option><option selected="">Second</option></select>
          <button type="submit" formaction="https://example.invalid/submit">Submit</button>
          <input type="image" src="illustration.svg" width="100" height="50" alt="Submit illustration"/>
          <meter min="0" max="100" value="75"/>
        </fieldset>
      </form>
      <table border="0" cellpadding="0" cellspacing="0"><tr><td align="center" valign="top">Value</td></tr></table>
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">
        <style>#swatch { fill: red; }</style><rect id="swatch" width="20" height="20"/>
      </svg>
      <style>#swatch { fill: blue; }</style>
    </section></body></html>`,
    )
    .file(
      "OPS/styles/book.css",
      `@import "accent.css";
      @namespace epub "http://www.idpf.org/2007/ops";
      section[epub|type="chapter"] { background-image: url("../illustration.svg"); }
      #opening { background-image: url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="); }`,
    )
    .file("OPS/styles/accent.css", "\uFEFF#opening { color: rgb(30, 45, 60); }")
    .file(
      "OPS/illustration.svg",
      `<?xml-stylesheet href="styles/poster.css" type="text/css"?>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
          <defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker></defs>
          <rect id="poster" width="200" height="100"/>
          <line x1="10" y1="10" x2="100" y2="10" stroke="black" marker-end="url(#arrow)"/>
        </svg>`,
    )
    .file("OPS/styles/poster.css", "#poster { fill: rgb(230, 200, 12); }")
    .file(
      "OPS/art.xhtml",
      `<html><head><meta name="viewport" content="width=1000,height=500"/><base href="https://publisher.example/edition/"/></head>
      <body><svg xmlns="http://www.w3.org/2000/svg" id="figure" viewBox="0 0 200 100"><rect width="200" height="100" fill="gold"/></svg>
      <a href="/illustrations">More illustrations</a></body></html>`,
    );
  const file = await archive.generateAsync({ type: "blob" });
  await using screen = await render(
    <div style={{ display: "flex", height: 400, width: 600 }}>
      <AttachmentFilePreview
        name="illustrated.epub"
        mimeType="application/epub+zip"
        sizeBytes={file.size}
        file={file}
      />
    </div>,
  );
  function frame() {
    return screen.container.querySelector("iframe");
  }
  // The cold worker parse takes most of a second; wait for the frame's onLoad pass before asserting.
  await vi.waitFor(
    () => {
      const doc = frame()?.contentDocument;
      expect(doc?.body.dir).toBe("rtl");
      expect(doc?.querySelector("epub-nested-link")).toBeNull();
    },
    { timeout: 10_000 },
  );
  await vi.waitFor(() => {
    const doc = frame()?.contentDocument;
    expect(doc?.querySelector("pre")?.textContent).toBe("\n      npm test");
    expect(doc?.getElementById("pagebreak")?.textContent).toBe("");
    const caption = doc?.querySelector("#caption > a");
    expect(caption?.textContent).toBe("Figure See table for details.");
    expect(caption?.querySelector("big")?.textContent).toBe("Figure");
    expect(caption?.querySelector("a")?.getAttribute("data-epub-anchor")).toBe("figure");
    expect(doc?.querySelector('a[href="#"][aria-disabled="true"]')?.textContent).toBe(
      "Legacy link",
    );
    const table = doc?.querySelector("table");
    const cell = table?.querySelector("td");
    expect(table?.querySelector(":scope > tr > td")).toBe(cell);
    expect(doc!.defaultView!.getComputedStyle(table!).borderSpacing).toBe("0px");
    const cellStyle = doc!.defaultView!.getComputedStyle(cell!);
    expect(cellStyle.paddingTop).toBe("0px");
    expect(cellStyle.textAlign).toMatch(/center$/);
    expect(cellStyle.verticalAlign).toBe("top");
    expect(doc?.querySelector("mfrac")?.namespaceURI).toBe("http://www.w3.org/1998/Math/MathML");
    expect(
      Array.from(doc?.querySelectorAll("#interval mo") ?? [], (operator) => operator.textContent),
    ).toEqual(["[", ";", ";", "]"]);
    const tupleFences = Array.from(doc?.querySelectorAll("#tuple > mo") ?? []);
    expect(tupleFences.map((operator) => operator.textContent)).toEqual(["⟨", "⟩"]);
    for (const fence of tupleFences) expect(fence.getBoundingClientRect().width).toBeGreaterThan(0);
    const videos = doc?.querySelectorAll("video");
    expect(videos?.[0]?.getAttribute("preload")).toBeNull();
    expect(videos?.[0]?.autoplay).toBe(false);
    expect(videos?.[1]?.preload).toBe("metadata");
    expect(doc?.querySelector("object")).toBeNull();
    expect(doc?.querySelector("#object-fallback")?.textContent).toBe("Fallback text");
    const illustration = doc?.querySelector<HTMLImageElement>("img#illustrated-object");
    expect(illustration?.alt).toBe("Illustration");
    expect(illustration?.naturalWidth).toBeGreaterThan(0);
    const workbook = doc?.querySelector<HTMLFormElement>("#workbook");
    expect(workbook?.querySelector("legend")?.textContent).toBe("Worksheet");
    expect(workbook?.hasAttribute("action")).toBe(false);
    expect(workbook?.hasAttribute("onsubmit")).toBe(false);
    const answer = workbook?.querySelector<HTMLInputElement>("#answer");
    expect(answer?.labels?.[0]?.textContent).toBe("Answer");
    expect(answer?.checked).toBe(true);
    expect(answer?.autofocus).toBe(false);
    expect(workbook?.querySelector("textarea")?.value).toBe("\nExample");
    expect(workbook?.querySelector("select")?.value).toBe("Second");
    expect(workbook?.querySelector("button")?.hasAttribute("formaction")).toBe(false);
    expect(workbook?.querySelector<HTMLInputElement>('input[type="image"]')?.src).toMatch(/^blob:/);
    expect(workbook?.querySelector("meter")?.value).toBe(75);
    expect(
      workbook?.querySelectorAll(
        "input:disabled, textarea:disabled, select:disabled, button:disabled",
      ),
    ).toHaveLength(5);
    expect(doc?.querySelector('a[data-epub-external][href="#"]')?.textContent).toBe("External");
    expect(
      doc?.querySelector('a[href="https://example.invalid/"],a[href^="javascript:"]'),
    ).toBeNull();
    expect(doc!.defaultView!.getComputedStyle(doc!.querySelector("#opening")!).color).toBe(
      "rgb(30, 45, 60)",
    );
    expect(
      doc!.defaultView!.getComputedStyle(doc!.querySelector("#opening")!).backgroundImage,
    ).toContain("blob:");
    expect(doc!.defaultView!.getComputedStyle(doc!.querySelector("#swatch")!).fill).toBe(
      "rgb(0, 0, 255)",
    );
    expect(
      doc!.defaultView!.getComputedStyle(doc!.querySelector("section")!).backgroundImage,
    ).toContain("blob:");
  });
  const link = frame()!.contentDocument!.querySelector<HTMLAnchorElement>("a[href]")!;
  link.click();
  await vi.waitFor(() => {
    const doc = frame()?.contentDocument;
    expect(doc?.querySelector("svg#figure rect")).toBeTruthy();
    expect(doc?.querySelector("base")).toBeNull();
    expect(doc?.querySelector('a[href="#"]')?.getAttribute("data-epub-external")).toBe(
      "https://publisher.example/illustrations",
    );
    expect(frame()?.contentWindow?.innerWidth).toBe(1000);
    expect(frame()?.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(frame()?.getBoundingClientRect().width).toBeLessThan(1000);
  });
  await screen.getByRole("button", { name: "Next chapter" }).click();
  await vi.waitFor(() => {
    const doc = frame()?.contentDocument;
    const poster = doc?.querySelector("#poster");
    expect(poster).toBeTruthy();
    expect(doc!.defaultView!.getComputedStyle(poster!).fill).toBe("rgb(230, 200, 12)");
    expect(doc?.querySelector("marker#arrow")?.getAttribute("orient")).toBe("auto");
    expect(doc?.querySelector("line")?.getAttribute("marker-end")).toBe("url(#arrow)");
    expect(doc?.scrollingElement?.scrollHeight).toBe(100);
  });
  await screen.getByRole("button", { name: "Previous chapter" }).click();
  await vi.waitFor(() =>
    expect(frame()?.contentDocument?.querySelector("svg#figure")).toBeTruthy(),
  );
  await screen.getByRole("button", { name: "Previous chapter" }).click();
  await vi.waitFor(() => expect(frame()?.contentDocument?.querySelector("#opening")).toBeTruthy());
});

it("highlights EPUB narration cues during playback and pauses on chapter change", async () => {
  const sampleRate = 8_000;
  const pcm = new Uint8Array(44 + sampleRate * 2 * 8);
  const header = new DataView(pcm.buffer);
  const encoder = new TextEncoder();
  pcm.set(encoder.encode("RIFF"), 0);
  pcm.set(encoder.encode("WAVEfmt "), 8);
  pcm.set(encoder.encode("data"), 36);
  header.setUint32(4, pcm.length - 8, true);
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  header.setUint32(40, pcm.length - 44, true);
  const { default: JSZip } = await import("jszip");
  const file = await new JSZip()
    .file(
      "META-INF/container.xml",
      '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
    )
    .file(
      "book.opf",
      `<package><manifest>
      <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml" media-overlay="read"/>
      <item id="end" href="end.xhtml" media-type="application/xhtml+xml"/>
      <item id="read" href="read.smil" media-type="application/smil+xml"/>
    </manifest><spine><itemref idref="chapter"/><itemref idref="end"/></spine></package>`,
    )
    .file(
      "chapter.xhtml",
      '<html><body><p id="first">First phrase</p><p id="second">Second phrase</p></body></html>',
    )
    .file("end.xhtml", "<html><body><p>End</p></body></html>")
    .file(
      "read.smil",
      `<smil xmlns="http://www.w3.org/ns/SMIL"><body>
      <par><text src="chapter.xhtml#first"/><audio src="audio.wav" clipEnd="4s"/></par>
      <par><text src="chapter.xhtml#second"/><audio src="audio.wav" clipBegin="4s" clipEnd="8s"/></par>
    </body></smil>`,
    )
    .file("audio.wav", pcm)
    .generateAsync({ type: "blob" });
  await using screen = await render(
    <div className="flex h-[480px] w-[360px]">
      <AttachmentFilePreview
        name="read-along.epub"
        mimeType="application/epub+zip"
        sizeBytes={file.size}
        file={file}
      />
    </div>,
  );
  const read = screen.getByRole("button", { name: "Read aloud" });
  await expect.element(read).toBeVisible();
  const player = screen.container.querySelector("audio")!;
  player.muted = true;
  const activePhrase = () =>
    screen.container
      .querySelector("iframe")
      ?.contentDocument?.querySelector(".t3-epub-narration-active")?.id;
  await read.click();
  await vi.waitFor(() => expect(activePhrase()).toBe("first"));
  player.currentTime = 4.1;
  await vi.waitFor(() => expect(activePhrase()).toBe("second"));
  await screen.getByRole("button", { name: "Next chapter" }).click();
  await vi.waitFor(() => expect(player.paused).toBe(true));
});

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
        const result = await officeWorkerReply(
          worker,
          {
            type: "open",
            kind: kind === "html" || kind === "encoded-html" ? "ipynb" : kind,
            bytes,
          },
          [bytes],
        );
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
          let html: string;
          if (result.type === "epub") {
            const page = await officeWorkerReply(worker, {
              type: "epub-page",
              index: result.first,
            });
            if (page.type !== "epub-page" || !("html" in page.result))
              throw new Error("Expected EPUB chapter");
            html = page.result.html;
          } else {
            if (result.type !== "document") throw new Error("Expected document");
            html = result.pages[0]!.html;
          }
          expect(html.includes("<img")).toBe(width === 2);
          expect(html).toContain("retained caption");
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

it.each([
  ["firmware", "Save it to open in an app that supports this format."],
  [".cache", "Save it to open in an app that supports this format."],
  ["a.dir/firmware", "Save it to open in an app that supports this format."],
  ["blob.foo", "Save it to open in an app that supports foo files."],
] as const)(
  "describes unsupported binary attachment %s without misreading its name as an extension",
  async (name, expected) => {
    const file = new Blob([new Uint8Array([0, 1, 2, 3])], { type: "application/octet-stream" });
    await using screen = await render(
      <AttachmentFilePreview name={name} mimeType={file.type} sizeBytes={file.size} file={file} />,
    );
    await expect
      .element(screen.getByText("No preview for this file", { exact: true }))
      .toBeVisible();
    await expect.element(screen.getByText(expected, { exact: true })).toBeVisible();
  },
);
