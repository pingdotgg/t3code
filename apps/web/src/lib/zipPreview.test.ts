import { IMAGE_DIMENSIONS_HEADER_BYTES } from "@t3tools/shared/imageDimensions";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vite-plus/test";

import { loadZipPreview, readZipPreviewResponse } from "./zipPreview";

const signal = () => new AbortController().signal;

function png(width = 800, height = 600) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function gif(frames: readonly (readonly [number, number])[], padding = 0) {
  const header = new Uint8Array([
    71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255,
  ]);
  const screen = new DataView(header.buffer);
  screen.setUint16(6, frames[0]![0], true);
  screen.setUint16(8, frames[0]![1], true);
  const bytes = Array.from(header);
  for (const [index, [width, height]] of frames.entries()) {
    if (index === 1 && padding > 0) {
      bytes.push(33, 254);
      for (let remaining = padding; remaining > 0; remaining -= 255) {
        const size = Math.min(remaining, 255);
        bytes.push(size, ...new Uint8Array(size));
      }
      bytes.push(0);
    }
    const frame = new Uint8Array([44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 1, 68, 0]);
    const view = new DataView(frame.buffer);
    view.setUint16(5, width, true);
    view.setUint16(7, height, true);
    bytes.push(...frame);
  }
  return new Uint8Array([...bytes, 59]);
}

async function archive(zip: JSZip) {
  return new Blob([await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" })]);
}

async function patchCentral(blob: Blob, patch: (view: DataView, offset: number) => void) {
  const bytes = await blob.arrayBuffer();
  const view = new DataView(bytes);
  for (let offset = 0; offset + 46 <= bytes.byteLength; offset++) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      patch(view, offset);
    }
  }
  return new Blob([bytes]);
}

describe("readZipPreviewResponse", () => {
  it("reads a streamed response into a ZIP blob", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]));
    const blob = await readZipPreviewResponse(response, signal());

    expect(blob.type).toBe("application/zip");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(response.body?.locked).toBe(false);
  });

  it("rejects failed responses and cancels their body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, { status: 500 });

    await expect(readZipPreviewResponse(response, signal())).rejects.toThrow(/could not load/i);
    expect(cancelled).toBe(true);
  });

  it("rejects responses without a body", async () => {
    await expect(readZipPreviewResponse(new Response(null), signal())).rejects.toThrow(
      /could not load/i,
    );
  });

  it("stops oversized downloads despite an incorrect Content-Length", async () => {
    let cancelled = false;
    let chunk = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(new Uint8Array(chunk++ === 0 ? 32 * 1024 * 1024 : 1));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const response = new Response(body, { headers: { "Content-Length": "1" } });

    await expect(readZipPreviewResponse(response, signal())).rejects.toThrow(/32 MiB/i);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it("cancels the body when the signal is already aborted", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      readZipPreviewResponse(new Response(body), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it("cancels an active download while the next chunk is pending", async () => {
    let readingNext!: () => void;
    const nextChunk = new Promise<void>((resolve) => {
      readingNext = resolve;
    });
    let chunk = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (chunk++ === 0) controller.enqueue(new Uint8Array([1, 2, 3]));
          else readingNext();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();
    const downloading = readZipPreviewResponse(new Response(body), controller.signal);
    await nextChunk;
    controller.abort();

    await expect(downloading).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it("releases the body after a download error", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("connection lost"));
      },
    });

    await expect(readZipPreviewResponse(new Response(body), signal())).rejects.toThrow(
      /connection lost/i,
    );
    expect(body.locked).toBe(false);
  });
});

describe("loadZipPreview", () => {
  it("lists implicit folders, empty folders, file names and uncompressed sizes", async () => {
    const zip = new JSZip();
    zip.file("photos/nested/PHOTO.PNG", new Uint8Array([1, 2, 3]), { createFolders: false });
    zip.file("readme.txt", "hello");
    zip.folder("empty");
    const preview = await loadZipPreview(await archive(zip), signal());

    expect(preview.entries).toEqual([
      { path: "empty/", name: "empty", isDirectory: true, sizeBytes: 0, mimeType: null },
      { path: "photos/", name: "photos", isDirectory: true, sizeBytes: 0, mimeType: null },
      { path: "photos/nested/", name: "nested", isDirectory: true, sizeBytes: 0, mimeType: null },
      {
        path: "photos/nested/PHOTO.PNG",
        name: "PHOTO.PNG",
        isDirectory: false,
        sizeBytes: 3,
        mimeType: "image/png",
      },
      { path: "readme.txt", name: "readme.txt", isDirectory: false, sizeBytes: 5, mimeType: null },
    ]);
  });

  it.each([true, false])(
    "allows 2,000 files without counting folders, createFolders=%s",
    async (createFolders) => {
      const zip = new JSZip();
      for (let index = 0; index < 2000; index++) {
        zip.file(`folder-${index}/file.txt`, "hello", { createFolders });
      }
      const preview = await loadZipPreview(await archive(zip), signal());

      expect(preview.entries.filter((entry) => !entry.isDirectory)).toHaveLength(2000);
      expect(preview.entries.filter((entry) => entry.isDirectory)).toHaveLength(2000);
    },
  );

  it("handles 2,000 files sharing 2,000 implied folders", async () => {
    const parent = "d/".repeat(2000);
    const zip = new JSZip();
    for (let index = 0; index < 2000; index++) {
      zip.file(`${parent}${index}.txt`, "hello", { createFolders: false });
    }
    const preview = await loadZipPreview(await archive(zip), signal());

    expect(preview.entries.filter((entry) => entry.isDirectory)).toHaveLength(2000);
    expect(preview.entries.filter((entry) => !entry.isDirectory)).toHaveLength(2000);
    const entry = preview.entries.find((entry) => entry.path === `${parent}1999.txt`)!;
    expect(await (await preview.readFile(entry, signal())).text()).toBe("hello");
  });

  it("hides macOS metadata without hiding normal dotfiles", async () => {
    const zip = new JSZip()
      .file("__MACOSX/src/._app.ts", "metadata")
      .file("src/.DS_Store", "metadata")
      .file("src/._app.ts", "metadata")
      .file("src/app.ts", "export const app = true;")
      .file(".gitignore", "node_modules");
    const preview = await loadZipPreview(await archive(zip), signal());

    expect(preview.entries.map((entry) => entry.path)).toEqual([
      ".gitignore",
      "src/",
      "src/app.ts",
    ]);
  });

  it("checks the image bytes even when the extension declares a different image type", async () => {
    const zip = new JSZip().file("photo.jpg", png());
    const preview = await loadZipPreview(await archive(zip), signal());
    const image = await preview.readFile(preview.entries[0]!, signal());

    expect(image.type).toBe("image/jpeg");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png());
  });

  it.each([
    ["photo.png", png(10000, 10000)],
    ["photo.jpg", png(4001, 4000)],
    ["photo.webp", png(8193, 1)],
    ["photo.jpg", new Uint8Array([255, 216, 255, 192, 0, 17, 8, 39, 16, 39, 16])],
    [
      "photo.webp",
      new Uint8Array([
        82, 73, 70, 70, 22, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 88, 10, 0, 0, 0, 0, 0, 0, 0, 15,
        39, 0, 15, 39, 0,
      ]),
    ],
    [
      "photo.gif",
      new Uint8Array([
        71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0, 0, 0, 44, 0, 0, 0, 0, 16, 39, 16, 39, 0, 2, 1, 68, 0,
        59,
      ]),
    ],
  ])("rejects oversized decoded images before creating a Blob: %s", async (name, bytes) => {
    const preview = await loadZipPreview(await archive(new JSZip().file(name, bytes)), signal());
    const blob = vi.spyOn(globalThis, "Blob");
    try {
      await expect(preview.readFile(preview.entries[0]!, signal())).rejects.toThrow(
        /16 million pixels.*8,192.*Download the ZIP/i,
      );
      expect(blob).not.toHaveBeenCalled();
    } finally {
      blob.mockRestore();
    }
  });

  it.each([
    ["photo.png", png(4000, 4000)],
    ["photo.png", png(8192, 1)],
    ["photo.gif", gif([[800, 600]])],
    [
      "photo.gif",
      Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) =>
        c.charCodeAt(0),
      ),
    ],
    ["photo.jpg", new Uint8Array([255, 216, 255, 192, 0, 17, 8, 2, 88, 3, 32])],
    [
      "photo.webp",
      new Uint8Array([
        82, 73, 70, 70, 22, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32, 10, 0, 0, 0, 0, 0, 0, 157, 1,
        42, 32, 3, 88, 2,
      ]),
    ],
    [
      "photo.webp",
      new Uint8Array([
        82, 73, 70, 70, 17, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 76, 5, 0, 0, 0, 47, 31, 195, 149,
        0,
      ]),
    ],
    [
      "photo.webp",
      new Uint8Array([
        82, 73, 70, 70, 22, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 88, 10, 0, 0, 0, 0, 0, 0, 0, 31, 3,
        0, 87, 2, 0,
      ]),
    ],
  ])("keeps bounded %s images available to the shared preview", async (name, bytes) => {
    const preview = await loadZipPreview(await archive(new JSZip().file(name, bytes)), signal());
    const image = await preview.readFile(preview.entries[0]!, signal());
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes);
    expect(image.type).toMatch(/^image\//);
  });

  it.each([
    ["photo.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="10000"/>'],
    ["photo.avif", "unsupported header"],
    ["photo.bmp", "BM"],
    ["photo.ico", "unsupported header"],
    ["photo.jpg", new Uint8Array([255, 216, 255])],
    ["photo.png", png(0, 600)],
    ["photo.gif", png().subarray(0, 20)],
    ["photo.gif", new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0, 0, 0, 33, 249, 255])],
    ["photo.png", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
  ])("blocks unreadable dimensions without decoding: %s", async (name, bytes) => {
    const preview = await loadZipPreview(await archive(new JSZip().file(name, bytes)), signal());
    await expect(preview.readFile(preview.entries[0]!, signal())).rejects.toThrow(
      /Cannot safely preview this image.*Download the ZIP/i,
    );
  });

  it.each([
    [0, 8193, 1],
    [0, 4001, 4000],
    [IMAGE_DIMENSIONS_HEADER_BYTES + 32, 8193, 1],
    [IMAGE_DIMENSIONS_HEADER_BYTES + 32, 4001, 4000],
  ])(
    "blocks an oversized later GIF frame, padding=%s width=%s height=%s",
    async (padding, width, height) => {
      const bytes = gif(
        [
          [1, 1],
          [width!, height!],
        ],
        padding,
      );
      const preview = await loadZipPreview(
        await archive(new JSZip().file("photo.png", bytes)),
        signal(),
      );
      const createBlob = vi.spyOn(globalThis, "Blob");
      try {
        await expect(preview.readFile(preview.entries[0]!, signal())).rejects.toThrow(
          /16 million pixels.*8,192/i,
        );
        expect(createBlob).not.toHaveBeenCalled();
      } finally {
        createBlob.mockRestore();
      }
    },
  );

  it.each([0, IMAGE_DIMENSIONS_HEADER_BYTES + 32])(
    "opens a safe animated GIF, padding=%s",
    async (padding) => {
      const bytes = gif(
        [
          [1, 1],
          [1, 1],
        ],
        padding,
      );
      const preview = await loadZipPreview(
        await archive(new JSZip().file("photo.gif", bytes)),
        signal(),
      );
      const image = await preview.readFile(preview.entries[0]!, signal());

      expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes);
    },
  );

  it.each([
    [
      "trailer",
      gif([
        [1, 1],
        [1, 1],
      ]).slice(0, -1),
    ],
    [
      "later image data",
      gif([
        [1, 1],
        [1, 1],
      ]).slice(0, -3),
    ],
    [
      "later descriptor",
      gif([
        [1, 1],
        [1, 1],
      ]).slice(0, -10),
    ],
    ["color table", gif([[1, 1]]).slice(0, 14)],
  ])("blocks a GIF with incomplete %s", async (_part, bytes) => {
    const preview = await loadZipPreview(
      await archive(new JSZip().file("photo.gif", bytes)),
      signal(),
    );

    await expect(preview.readFile(preview.entries[0]!, signal())).rejects.toThrow(
      /Cannot safely preview/i,
    );
  });

  it("reads a JPEG frame across extracted chunks but rejects headers beyond the scan limit", async () => {
    for (const segments of [1, 5]) {
      const bytes = new Uint8Array(2 + segments * 65537 + 9);
      bytes.set([255, 216]);
      for (let index = 0; index < segments; index++) {
        bytes.set([255, 224, 255, 255], 2 + index * 65537);
      }
      bytes.set([255, 192, 0, 17, 8, 2, 88, 3, 32], bytes.length - 9);
      const preview = await loadZipPreview(
        await archive(new JSZip().file("photo.jpg", bytes)),
        signal(),
      );
      const reading = preview.readFile(preview.entries[0]!, signal());
      if (segments === 1) expect((await reading).size).toBe(bytes.length);
      else await expect(reading).rejects.toThrow(/Cannot safely preview/i);
    }
  });

  it.each(["photos\\image.png", "photos\\\\image.png", "photos//image.png"])(
    "keeps folder and file paths consistent for %s",
    async (path) => {
      const zip = new JSZip().file(path, png(), { createFolders: false });
      zip.file(path.slice(0, -"image.png".length), null, { dir: true, createFolders: false });
      const preview = await loadZipPreview(await archive(zip), signal());

      expect(preview.entries).toEqual([
        { path: "photos/", name: "photos", isDirectory: true, sizeBytes: 0, mimeType: null },
        {
          path: "photos/image.png",
          name: "image.png",
          isDirectory: false,
          sizeBytes: 24,
          mimeType: "image/png",
        },
      ]);
      const image = await preview.readFile(preview.entries[1]!, signal());
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(png());
    },
  );

  it.each([false, true])(
    "keeps normalized path collisions accessible, reversed=%s",
    async (reverse) => {
      const names = ["photos\\image.png", "photos/image.png", "photos//image.png"];
      if (reverse) names.reverse();
      const zip = new JSZip();
      for (const [index, name] of names.entries()) {
        zip.file(name, png(100 + index, 1), { createFolders: false });
      }
      zip.file("photos/image (2).png", png(200, 1), { createFolders: false });
      zip.folder("photos/image (3).png");
      zip.folder("photos/image.png");
      const preview = await loadZipPreview(await archive(zip), signal());
      const files = preview.entries.filter((entry) => !entry.isDirectory);

      expect(files.map((entry) => entry.path)).toEqual([
        "photos/image (2).png",
        "photos/image (4).png",
        "photos/image (5).png",
        "photos/image.png",
      ]);
      expect(preview.entries.some((entry) => entry.path === "photos/image.png/")).toBe(true);
      const widths = [200, 101, 102, 100];
      for (const [index, entry] of files.entries()) {
        const image = await preview.readFile(entry, signal());
        expect(image.type).toBe("image/png");
        expect(new Uint8Array(await image.arrayBuffer())).toEqual(png(widths[index]!, 1));
      }
    },
  );

  it("does not decompress files while listing the archive", async () => {
    const blob = await patchCentral(
      await archive(new JSZip().file("broken.png", "x")),
      (view, offset) => {
        view.setUint32(offset + 24, 2, true);
      },
    );
    const preview = await loadZipPreview(blob, signal());

    expect(preview.entries[0]?.sizeBytes).toBe(2);
    await expect(preview.readFile(preview.entries[0]!, signal())).rejects.toThrow(
      /could not read/i,
    );
  });

  it.each(["STORE", "DEFLATE"] as const)(
    "checks only the selected entry's CRC before creating a Blob, compression=%s",
    async (compression) => {
      const contents = new Uint8Array(48 * 1024).fill(42);
      const zip = new JSZip()
        .file("good.txt", contents)
        .file("broken.txt", contents)
        .file("empty.txt", "")
        .file("broken-empty.txt", "");
      let index = 0;
      const blob = await patchCentral(
        new Blob([await zip.generateAsync({ type: "arraybuffer", compression })]),
        (view, offset) => {
          if (index++ % 2 === 1)
            view.setUint32(offset + 16, view.getUint32(offset + 16, true) ^ 1, true);
        },
      );
      const preview = await loadZipPreview(blob, signal());
      const good = preview.entries.find((entry) => entry.name === "good.txt")!;
      const empty = preview.entries.find((entry) => entry.name === "empty.txt")!;
      const broken = preview.entries.find((entry) => entry.name === "broken.txt")!;
      const brokenEmpty = preview.entries.find((entry) => entry.name === "broken-empty.txt")!;

      expect(new Uint8Array(await (await preview.readFile(good, signal())).arrayBuffer())).toEqual(
        contents,
      );
      expect((await preview.readFile(empty, signal())).size).toBe(0);
      const createBlob = vi.spyOn(globalThis, "Blob");
      try {
        await expect(preview.readFile(broken, signal())).rejects.toThrow(/file data is corrupt/i);
        await expect(preview.readFile(brokenEmpty, signal())).rejects.toThrow(
          /file data is corrupt/i,
        );
        expect(createBlob).not.toHaveBeenCalled();
      } finally {
        createBlob.mockRestore();
      }
    },
  );

  it.each([
    ["src/app.ts", "export const value = 1;", "application/octet-stream"],
    ["app.log", "ready", "application/octet-stream"],
    ["README.md", "# Project", "application/octet-stream"],
    ["data.csv", "name,value\nexample,1", "application/octet-stream"],
    ["document.pdf", "%PDF-1.4", "application/pdf"],
    ["clip.mp4", "media", "video/mp4"],
    ["sound.mp3", "media", "audio/mpeg"],
  ])(
    "extracts only the selected file %s for the shared viewer",
    async (name, contents, mimeType) => {
      const preview = await loadZipPreview(
        await archive(new JSZip().file(name, contents)),
        signal(),
      );
      const entry = preview.entries.find((entry) => !entry.isDirectory)!;
      const file = await preview.readFile(entry, signal());

      expect(file.type).toBe(mimeType);
      expect(await file.text()).toBe(contents);
      const folder = preview.entries.find((entry) => entry.isDirectory);
      if (folder)
        await expect(preview.readFile(folder, signal())).rejects.toThrow(/not available/i);
    },
  );

  it("rejects corrupt archives with a clear error", async () => {
    await expect(loadZipPreview(new Blob(["not a zip"]), signal())).rejects.toThrow(
      /corrupt|valid ZIP/i,
    );
  });

  it("rejects a hidden directory selected by an EOCD inside the ZIP comment before parsing", async () => {
    const zip = new JSZip();
    for (let index = 0; index < 2001; index++) zip.file(`${index}.txt`, "");
    const bytes = await (await archive(zip)).arrayBuffer();
    const view = new DataView(bytes);
    const end = bytes.byteLength - 22;
    const directoryOffset = view.getUint32(end + 16, true);
    const comment = new Uint8Array(23);
    const fake = new DataView(comment.buffer);
    fake.setUint32(0, 0x06054b50, true);
    fake.setUint16(8, 1, true);
    fake.setUint16(10, 1, true);
    fake.setUint32(12, bytes.byteLength - directoryOffset, true);
    fake.setUint32(16, directoryOffset, true);
    view.setUint16(end + 8, 0, true);
    view.setUint16(end + 10, 0, true);
    view.setUint32(end + 12, 0, true);
    view.setUint32(end + 16, end, true);
    view.setUint16(end + 20, comment.length, true);
    const crafted = new Blob([bytes, comment]);

    expect(Object.keys((await JSZip.loadAsync(await crafted.arrayBuffer())).files)).toHaveLength(
      2001,
    );
    const parse = vi.spyOn(JSZip.prototype, "loadAsync");
    try {
      await expect(loadZipPreview(crafted, signal())).rejects.toThrow(/corrupt|valid ZIP/i);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("rejects a truncated final EOCD signature before parsing", async () => {
    const zip = new JSZip().file("a.txt", "hello");
    const blob = new Blob([
      await zip.generateAsync({ type: "arraybuffer", comment: "PK\u0005\u0006" }),
    ]);
    const parse = vi.spyOn(JSZip.prototype, "loadAsync");
    try {
      await expect(loadZipPreview(blob, signal())).rejects.toThrow(/corrupt|valid ZIP/i);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("accepts an ordinary ZIP comment and prepended data", async () => {
    const zip = new JSZip().file("a.txt", "hello");
    const bytes = await zip.generateAsync({ type: "arraybuffer", comment: "Archive notes" });
    const preview = await loadZipPreview(new Blob(["prefix", bytes]), signal());

    expect(await (await preview.readFile(preview.entries[0]!, signal())).text()).toBe("hello");
  });

  it.each([4, 6, 8])("rejects the EOCD ZIP64 sentinel at offset %s", async (offset) => {
    const bytes = await (await archive(new JSZip().file("a.txt", "hello"))).arrayBuffer();
    new DataView(bytes).setUint16(bytes.byteLength - 22 + offset, 0xffff, true);

    await expect(loadZipPreview(new Blob([bytes]), signal())).rejects.toThrow(/ZIP64/i);
  });

  it.each([20, 24, 34, 42])("rejects the central ZIP64 sentinel at offset %s", async (field) => {
    const blob = await patchCentral(
      await archive(new JSZip().file("a.txt", "hello")),
      (view, offset) => {
        if (field === 34) view.setUint16(offset + field, 0xffff, true);
        else view.setUint32(offset + field, 0xffffffff, true);
      },
    );

    await expect(loadZipPreview(blob, signal())).rejects.toThrow(/ZIP64/i);
  });

  it("rejects entries assigned to another disk", async () => {
    const blob = await patchCentral(
      await archive(new JSZip().file("a.txt", "hello")),
      (view, offset) => {
        view.setUint16(offset + 34, 1, true);
      },
    );

    await expect(loadZipPreview(blob, signal())).rejects.toThrow(/multi-part/i);
  });

  it("rejects encrypted archives", async () => {
    const blob = await patchCentral(
      await archive(new JSZip().file("photo.png", "x")),
      (view, offset) => {
        view.setUint16(offset + 8, 1, true);
      },
    );

    await expect(loadZipPreview(blob, signal())).rejects.toThrow(/encrypted/i);
  });

  it.each(["zip64", "multipart"])("rejects unsupported %s archive headers", async (kind) => {
    const bytes = await (await archive(new JSZip().file("a.txt", "x"))).arrayBuffer();
    const view = new DataView(bytes);
    const end = bytes.byteLength - 22;
    if (kind === "zip64") view.setUint16(end + 10, 0xffff, true);
    else view.setUint16(end + 4, 1, true);
    await expect(loadZipPreview(new Blob([bytes]), signal())).rejects.toThrow(
      kind === "zip64" ? /ZIP64/i : /multi-part/i,
    );
  });

  it("rejects unsupported compression", async () => {
    const blob = await patchCentral(
      await archive(new JSZip().file("photo.png", "x")),
      (view, offset) => {
        view.setUint16(offset + 10, 99, true);
      },
    );

    await expect(loadZipPreview(blob, signal())).rejects.toThrow(/compression.*not supported/i);
  });

  it("rejects archives above the compressed size limit", async () => {
    await expect(
      loadZipPreview(new Blob([new Uint8Array(32 * 1024 * 1024 + 1)]), signal()),
    ).rejects.toThrow(/32 MiB/i);
  });

  it("rejects too many entries even with a forged entry count", async () => {
    const zip = new JSZip();
    for (let index = 0; index < 2001; index++) {
      zip.file(`${index}.txt`, "");
    }
    const bytes = await (await archive(zip)).arrayBuffer();
    const view = new DataView(bytes);
    view.setUint16(bytes.byteLength - 22 + 8, 1, true);
    view.setUint16(bytes.byteLength - 22 + 10, 1, true);

    await expect(loadZipPreview(new Blob([bytes]), signal())).rejects.toThrow(/2,000 files/i);
  });

  it("bounds decoded file counts when directory attributes disagree", async () => {
    const zip = new JSZip();
    for (let index = 0; index < 2001; index++) zip.file(`${index}.txt`, "");
    let count = 0;
    const blob = await patchCentral(await archive(zip), (view, offset) => {
      if (count++ < 1000) view.setUint32(offset + 38, 0x40000000, true);
    });
    await expect(loadZipPreview(blob, signal())).rejects.toThrow(/2,000 files/i);
  });

  it("bounds implicit directories separately from files", async () => {
    const zip = new JSZip().file(`${"folder/".repeat(2001)}image.png`, "x", {
      createFolders: false,
    });

    await expect(loadZipPreview(await archive(zip), signal())).rejects.toThrow(/2,000 files/i);
  });

  it("lists oversized images but rejects image reads", async () => {
    const blob = await patchCentral(
      await archive(new JSZip().file("photo.png", "x")),
      (view, offset) => {
        view.setUint32(offset + 24, 10 * 1024 * 1024 + 1, true);
      },
    );
    const preview = await loadZipPreview(blob, signal());

    await expect(preview.readFile(preview.entries[0]!, signal())).rejects.toThrow(/10 MiB/i);
  });

  it("stops inflated image data at the limit even when the stored size is forged", async () => {
    const zip = new JSZip().file("photo.png", new Uint8Array(10 * 1024 * 1024 + 1));
    const blob = await patchCentral(await archive(zip), (view, offset) => {
      view.setUint32(offset + 24, 1, true);
    });
    const preview = await loadZipPreview(blob, signal());

    await expect(preview.readFile(preview.entries[0]!, signal())).rejects.toThrow(/10 MiB/i);
  });

  it("rejects a cancelled archive read", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(loadZipPreview(new Blob(), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("cancels an archive load while the blob read is pending", async () => {
    let resolveRead!: (bytes: ArrayBuffer) => void;
    const reading = new Promise<ArrayBuffer>((resolve) => {
      resolveRead = resolve;
    });
    const blob = new (class extends Blob {
      override arrayBuffer() {
        return reading;
      }
    })();
    const controller = new AbortController();
    const loading = loadZipPreview(blob, controller.signal);
    controller.abort();

    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    resolveRead(new ArrayBuffer(0));
  });

  it("cancels image reads before decompression starts", async () => {
    const preview = await loadZipPreview(
      await archive(new JSZip().file("photo.png", "x")),
      signal(),
    );
    const controller = new AbortController();
    const image = preview.readFile(preview.entries[0]!, controller.signal);
    controller.abort();

    await expect(image).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels image reads after the stream starts", async () => {
    const contents = new Uint8Array(64 * 1024);
    contents.set(png());
    const zip = new JSZip().file("photo.png", contents);
    const preview = await loadZipPreview(await archive(zip), signal());
    const controller = new AbortController();
    const prototype = Object.getPrototypeOf(zip.file("photo.png")) as {
      internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
    };
    const original = prototype.internalStream;
    const streaming = vi.spyOn(prototype, "internalStream").mockImplementation(function (
      this: typeof prototype,
      type,
    ) {
      return original.call(this, type).on("data", () => controller.abort());
    });
    try {
      await expect(preview.readFile(preview.entries[0]!, controller.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
    } finally {
      streaming.mockRestore();
    }

    expect((await preview.readFile(preview.entries[0]!, signal())).size).toBe(64 * 1024);
  });
});
