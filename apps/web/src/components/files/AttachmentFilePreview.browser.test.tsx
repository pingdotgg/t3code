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

// Real worker imports and WASM initialization can exceed waitFor's default second
// when the full browser project runs concurrently on CI.
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
import { OFFICE_PREVIEW_MAX_COLUMNS, type OfficeWorkerResult } from "./officePreviewProtocol";

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
    await client.call("open", { bytes }, { transfer: [bytes] });
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
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[role="alert"]')?.textContent).toContain(
        "Show Mermaid source",
      ),
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
  let resolveResponse!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  using _fetch = stubGlobal(
    "fetch",
    vi.fn(() => response),
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
  resolveResponse(new Response("invalid-office-file"));
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
    const file = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    const src = URL.createObjectURL(file);
    try {
      await using screen = await render(
        <div style={{ display: "flex", height: 400, width: 600 }}>
          <OfficeFilePreview name="custom.xlsx" src={src} kind="xlsx" sizeBytes={file.size} />
        </div>,
      );
      await vi.waitFor(
        () =>
          expect(screen.container.textContent).toContain(
            row > 250000 ? "This workbook exceeds the preview limit" : "worksheet value",
          ),
        { timeout: 10_000 },
      );
    } finally {
      URL.revokeObjectURL(src);
    }
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
  const { default: fontUrl } =
    await import("../../../node_modules/@betteroffice/fonts/assets/Carlito-Regular.ttf?url");
  const file = await (await fetch(fontUrl)).blob();
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
