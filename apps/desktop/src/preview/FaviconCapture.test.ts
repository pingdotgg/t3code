import { describe, expect, it, vi } from "vite-plus/test";

import {
  MAX_FAVICON_CANDIDATES,
  MAX_FAVICON_RESPONSE_BYTES,
  captureFavicon,
  selectFaviconCandidates,
} from "./FaviconCapture.ts";

const PNG = "data:image/png;base64,cG5n";
const SOURCE_PNG = Buffer.alloc(24);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(SOURCE_PNG);
SOURCE_PNG.writeUInt32BE(1, 16);
SOURCE_PNG.writeUInt32BE(1, 20);
const SOURCE_PNG_URL = `data:image/png;base64,${SOURCE_PNG.toString("base64")}`;

function sourceGif(
  width: number,
  height: number,
  frameWidth = width,
  frameHeight = height,
  additionalFrames: ReadonlyArray<{
    readonly left?: number;
    readonly top?: number;
    readonly width: number;
    readonly height: number;
  }> = [],
): Buffer {
  const frames = [{ width: frameWidth, height: frameHeight }, ...additionalFrames];
  const buffer = Buffer.alloc(13 + frames.length * 12 + 1);
  buffer.write("GIF89a", 0, "ascii");
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  let offset = 13;
  for (const frame of frames) {
    buffer[offset] = 0x2c;
    buffer.writeUInt16LE(frame.left ?? 0, offset + 1);
    buffer.writeUInt16LE(frame.top ?? 0, offset + 3);
    buffer.writeUInt16LE(frame.width, offset + 5);
    buffer.writeUInt16LE(frame.height, offset + 7);
    offset += 10;
    buffer[offset] = 2;
    buffer[offset + 1] = 0;
    offset += 2;
  }
  buffer[offset] = 0x3b;
  return buffer;
}

function sourceJpeg(
  width: number,
  height: number,
  orientations: number | ReadonlyArray<number> = [],
): Buffer {
  const frame = Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x07,
    0x08,
    height >>> 8,
    height & 0xff,
    width >>> 8,
    width & 0xff,
  ]);
  const app1Segments = (typeof orientations === "number" ? [orientations] : orientations).map(
    (orientation) => sourceJpegExifSegment([orientation]),
  );
  return Buffer.concat([frame.subarray(0, 2), ...app1Segments, frame.subarray(2)]);
}

function sourceJpegApp1Segment(payload: Buffer): Buffer {
  const app1 = Buffer.alloc(4 + payload.byteLength);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.byteLength + 2, 2);
  payload.copy(app1, 4);
  return app1;
}

function sourceJpegExifSegment(
  orientations: ReadonlyArray<number>,
  options?: {
    readonly byteOrder?: "II" | "MM";
    readonly magic?: number;
    readonly padding?: number;
  },
): Buffer {
  const exif = Buffer.alloc(20 + orientations.length * 12);
  exif.write("Exif\0\0", 0, "binary");
  exif[5] = options?.padding ?? 0;
  const littleEndian = options?.byteOrder !== "MM";
  exif.write(littleEndian ? "II" : "MM", 6, "ascii");
  const writeUInt16 = (value: number, offset: number) =>
    littleEndian ? exif.writeUInt16LE(value, offset) : exif.writeUInt16BE(value, offset);
  const writeUInt32 = (value: number, offset: number) =>
    littleEndian ? exif.writeUInt32LE(value, offset) : exif.writeUInt32BE(value, offset);
  writeUInt16(options?.magic ?? 42, 8);
  writeUInt32(8, 10);
  writeUInt16(orientations.length, 14);
  orientations.forEach((orientation, index) => {
    const entryOffset = 16 + index * 12;
    writeUInt16(0x0112, entryOffset);
    writeUInt16(3, entryOffset + 2);
    writeUInt32(1, entryOffset + 4);
    writeUInt16(orientation, entryOffset + 8);
  });
  return sourceJpegApp1Segment(exif);
}

function sourceJpegWithApp1Segments(
  width: number,
  height: number,
  segments: ReadonlyArray<Buffer>,
): Buffer {
  const frame = sourceJpeg(width, height);
  return Buffer.concat([frame.subarray(0, 2), ...segments, frame.subarray(2)]);
}

function sourceJpegWithOrientationEntries(
  width: number,
  height: number,
  orientations: ReadonlyArray<number>,
): Buffer {
  return sourceJpegWithApp1Segments(width, height, [sourceJpegExifSegment(orientations)]);
}

function sourceJpegWithEndianAlias(alias: number, byteOrder: "II" | "MM"): Buffer {
  const exif = sourceJpegExifSegment([6], { byteOrder });
  exif[10] = alias;
  exif[11] = alias;
  return sourceJpegWithApp1Segments(64, 32, [exif]);
}

function sourceJpegExifWithSubIfd(options: {
  readonly rootOrientation?: number;
  readonly subIfdFirst?: boolean;
  readonly subIfdOrientation: number;
}): Buffer {
  const rootEntries = options.rootOrientation === undefined ? 1 : 2;
  const rootIfdOffset = 14;
  const subIfdOffset = rootIfdOffset + 2 + rootEntries * 12 + 4;
  const exif = Buffer.alloc(subIfdOffset + 2 + 12 + 4);
  exif.write("Exif\0\0", 0, "binary");
  exif.write("II", 6, "ascii");
  exif.writeUInt16LE(42, 8);
  exif.writeUInt32LE(8, 10);
  exif.writeUInt16LE(rootEntries, rootIfdOffset);

  const writeOrientation = (offset: number, orientation: number) => {
    exif.writeUInt16LE(0x0112, offset);
    exif.writeUInt16LE(3, offset + 2);
    exif.writeUInt32LE(1, offset + 4);
    exif.writeUInt16LE(orientation, offset + 8);
  };
  const writeSubIfdPointer = (offset: number) => {
    exif.writeUInt16LE(0x8769, offset);
    exif.writeUInt16LE(4, offset + 2);
    exif.writeUInt32LE(1, offset + 4);
    exif.writeUInt32LE(subIfdOffset - 6, offset + 8);
  };

  const firstRootEntryOffset = rootIfdOffset + 2;
  if (options.rootOrientation === undefined) {
    writeSubIfdPointer(firstRootEntryOffset);
  } else if (options.subIfdFirst) {
    writeSubIfdPointer(firstRootEntryOffset);
    writeOrientation(firstRootEntryOffset + 12, options.rootOrientation);
  } else {
    writeOrientation(firstRootEntryOffset, options.rootOrientation);
    writeSubIfdPointer(firstRootEntryOffset + 12);
  }

  exif.writeUInt16LE(1, subIfdOffset);
  writeOrientation(subIfdOffset + 2, options.subIfdOrientation);
  return sourceJpegApp1Segment(exif);
}

function sourceJpegExifWithSubIfdPointers(options: {
  readonly pointerCount: number;
  readonly subIfdEntries: number;
}): Buffer {
  const { pointerCount, subIfdEntries } = options;
  const rootIfdOffset = 14;
  const rootEntries = pointerCount + 1;
  const subIfdOffset = rootIfdOffset + 2 + rootEntries * 12 + 4;
  const exif = Buffer.alloc(subIfdOffset + 2 + subIfdEntries * 12 + 4);
  exif.write("Exif\0\0", 0, "binary");
  exif.write("II", 6, "ascii");
  exif.writeUInt16LE(42, 8);
  exif.writeUInt32LE(8, 10);
  exif.writeUInt16LE(rootEntries, rootIfdOffset);
  for (let index = 0; index < pointerCount; index += 1) {
    const entryOffset = rootIfdOffset + 2 + index * 12;
    exif.writeUInt16LE(0x8769, entryOffset);
    exif.writeUInt16LE(4, entryOffset + 2);
    exif.writeUInt32LE(1, entryOffset + 4);
    exif.writeUInt32LE(subIfdOffset - 6, entryOffset + 8);
  }
  const orientationOffset = rootIfdOffset + 2 + pointerCount * 12;
  exif.writeUInt16LE(0x0112, orientationOffset);
  exif.writeUInt16LE(3, orientationOffset + 2);
  exif.writeUInt32LE(1, orientationOffset + 4);
  exif.writeUInt16LE(6, orientationOffset + 8);

  exif.writeUInt16LE(subIfdEntries, subIfdOffset);
  for (let index = 0; index < subIfdEntries; index += 1) {
    const entryOffset = subIfdOffset + 2 + index * 12;
    exif.writeUInt16LE(1, entryOffset);
    exif.writeUInt16LE(3, entryOffset + 2);
    exif.writeUInt32LE(1, entryOffset + 4);
  }
  return sourceJpegApp1Segment(exif);
}

function sourceJpegExifWithOverlappingSubIfds(pointerCount: number, subIfdEntries: number): Buffer {
  const rootIfdOffset = 14;
  const rootEntries = pointerCount + 1;
  const subIfdOffset = rootIfdOffset + 2 + rootEntries * 12 + 4;
  const exif = Buffer.alloc(subIfdOffset + pointerCount * 2 + 2 + subIfdEntries * 12);
  exif.write("Exif\0\0", 0, "binary");
  exif.write("II", 6, "ascii");
  exif.writeUInt32LE(8, 10);
  exif.writeUInt16LE(rootEntries, rootIfdOffset);
  for (let index = 0; index < pointerCount; index += 1) {
    const entryOffset = rootIfdOffset + 2 + index * 12;
    exif.writeUInt16LE(0x8769, entryOffset);
    exif.writeUInt16LE(4, entryOffset + 2);
    exif.writeUInt32LE(1, entryOffset + 4);
    exif.writeUInt32LE(subIfdOffset + index * 2 - 6, entryOffset + 8);
    exif.writeUInt16LE(subIfdEntries, subIfdOffset + index * 2);
  }
  const orientationOffset = rootIfdOffset + 2 + pointerCount * 12;
  exif.writeUInt16LE(0x0112, orientationOffset);
  exif.writeUInt16LE(3, orientationOffset + 2);
  exif.writeUInt32LE(1, orientationOffset + 4);
  exif.writeUInt16LE(6, orientationOffset + 8);
  return sourceJpegApp1Segment(exif);
}

function sourceWebp(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

function sourceIco(embedded: Buffer): Buffer {
  const buffer = Buffer.alloc(22 + embedded.byteLength);
  buffer.writeUInt16LE(1, 2);
  buffer.writeUInt16LE(1, 4);
  buffer.writeUInt32LE(embedded.byteLength, 14);
  buffer.writeUInt32LE(22, 18);
  embedded.copy(buffer, 22);
  return buffer;
}

function makeUnsafePng(): Buffer {
  const buffer = Buffer.from(SOURCE_PNG);
  buffer.writeUInt32BE(4096, 16);
  buffer.writeUInt32BE(4096, 20);
  return buffer;
}

function sourcePng(width: number, height: number): Buffer {
  const buffer = Buffer.from(SOURCE_PNG);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function makeUnsafeDib(): Buffer {
  const buffer = Buffer.alloc(40);
  buffer.writeUInt32LE(40, 0);
  buffer.writeInt32LE(4096, 4);
  buffer.writeInt32LE(4096, 8);
  return buffer;
}

function makeWebContents(options?: {
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly rasterize?: (code: string) => Promise<unknown>;
}) {
  const fetch = vi.fn(
    options?.fetch ??
      (async () =>
        new Response(new Uint8Array(SOURCE_PNG), {
          headers: { "content-type": "image/png" },
        })),
  );
  const executeJavaScriptInIsolatedWorld = vi.fn(
    async (_worldId: number, scripts: ReadonlyArray<{ readonly code: string }>) =>
      options?.rasterize ? options.rasterize(scripts[0]?.code ?? "") : PNG,
  );
  return {
    webContents: {
      session: { fetch },
      executeJavaScriptInIsolatedWorld,
    } as never,
    executeJavaScriptInIsolatedWorld,
    fetch,
  };
}

const JPEG_LANDSCAPE_LAYOUT = {
  draw: "context.drawImage(bitmap, 0, 8, 32, 16)",
  resizeHeight: 16,
  resizeWidth: 32,
} as const;
const JPEG_PORTRAIT_LAYOUT = {
  draw: "context.drawImage(bitmap, 8, 0, 16, 32)",
  resizeHeight: 32,
  resizeWidth: 16,
} as const;

async function expectJpegLayout(
  source: Buffer,
  layout: typeof JPEG_LANDSCAPE_LAYOUT | typeof JPEG_PORTRAIT_LAYOUT,
): Promise<void> {
  const { webContents } = makeWebContents({
    rasterize: async (code) => {
      expect(code).toContain(`resizeWidth: ${layout.resizeWidth}`);
      expect(code).toContain(`resizeHeight: ${layout.resizeHeight}`);
      expect(code).toContain(layout.draw);
      return PNG;
    },
  });

  expect(
    await captureFavicon({
      webContents,
      pageUrl: "https://example.com/page",
      candidates: [`data:image/jpeg;base64,${source.toString("base64")}`],
      signal: new AbortController().signal,
    }),
  ).toEqual({ kind: "captured", dataUrl: PNG });
}

describe("selectFaviconCandidates", () => {
  it("filters and deduplicates before applying the candidate cap", () => {
    const valid = Array.from(
      { length: MAX_FAVICON_CANDIDATES + 2 },
      (_, index) => `https://example.com/favicon-${index}.png`,
    );
    expect(
      selectFaviconCandidates([
        ...Array.from({ length: 64 }, () => "javascript:alert(1)"),
        valid[0]!,
        valid[0]!,
        ...valid.slice(1),
      ]),
    ).toEqual(valid.slice(0, MAX_FAVICON_CANDIDATES));
  });

  it("bounds raw candidate scanning independently of the usable-candidate cap", () => {
    const oversizedInvalid = `javascript:${"x".repeat(2_048)}`;
    expect(
      selectFaviconCandidates([
        ...Array.from({ length: 128 }, () => oversizedInvalid),
        "https://example.com/too-late.png",
      ]),
    ).toEqual([]);
  });
});

describe("captureFavicon", () => {
  it.each([
    {
      label: "same-origin",
      pageUrl: "https://example.com/page",
      faviconUrl: "https://example.com/favicon.png",
      credentials: "include",
    },
    {
      label: "cross-origin",
      pageUrl: "https://example.com/page",
      faviconUrl: "https://cdn.example.net/favicon.png",
      credentials: "omit",
    },
  ])("uses the explicit credential policy for $label requests", async (testCase) => {
    const { webContents, fetch } = makeWebContents();
    const result = await captureFavicon({
      webContents,
      pageUrl: testCase.pageUrl,
      candidates: [testCase.faviconUrl],
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ kind: "captured", dataUrl: PNG });
    expect(fetch).toHaveBeenCalledWith(
      testCase.faviconUrl,
      expect.objectContaining({ credentials: testCase.credentials, redirect: "error" }),
    );
  });

  it("decodes base64 and percent-encoded inline images without fetching", async () => {
    const { webContents, fetch, executeJavaScriptInIsolatedWorld } = makeWebContents();
    const percentEncodedPng = [...SOURCE_PNG]
      .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
      .join("");

    for (const candidate of [SOURCE_PNG_URL, `data:image/png,${percentEncodedPng}`]) {
      expect(
        await captureFavicon({
          webContents,
          pageUrl: "https://example.com/page",
          candidates: [candidate],
          signal: new AbortController().signal,
        }),
      ).toEqual({ kind: "captured", dataUrl: PNG });
    }

    expect(fetch).not.toHaveBeenCalled();
    expect(executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(2);
  });

  it("tries the next candidate after an ordinary rejection", async () => {
    const { webContents, fetch } = makeWebContents({
      fetch: async (url) =>
        url.endsWith("first.png")
          ? new Response(null, { status: 404 })
          : new Response(new Uint8Array(SOURCE_PNG), {
              headers: { "content-type": "image/png" },
            }),
    });

    expect(
      await captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: ["https://example.com/first.png", "https://example.com/second.png"],
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: "captured", dataUrl: PNG });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("cancels a rejected response body before trying the next candidate", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    const { webContents, fetch } = makeWebContents({
      fetch: async (url) =>
        url.endsWith("first.png")
          ? new Response(body, { status: 404 })
          : new Response(new Uint8Array(SOURCE_PNG), {
              headers: { "content-type": "image/png" },
            }),
    });

    expect(
      await captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: ["https://example.com/first.png", "https://example.com/second.png"],
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: "captured", dataUrl: PNG });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops a pending fetch when its capture is aborted", async () => {
    const controller = new AbortController();
    const { webContents } = makeWebContents({
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    });
    const capture = captureFavicon({
      webContents,
      pageUrl: "https://example.com/page",
      candidates: ["https://example.com/favicon.png"],
      signal: controller.signal,
    });
    controller.abort();
    expect(await capture).toEqual({ kind: "none" });
  });

  it("ends candidate fallback when the overall capture deadline expires", async () => {
    const timeoutController = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const { webContents, fetch } = makeWebContents({
      fetch: (url, init) => {
        if (url.endsWith("first.png")) return Promise.resolve(new Response(null, { status: 404 }));
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      },
    });
    try {
      const capture = captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: [
          "https://example.com/first.png",
          "https://example.com/second.png",
          "https://example.com/third.png",
        ],
        signal: new AbortController().signal,
      });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      timeoutController.abort(new DOMException("capture timed out", "TimeoutError"));

      expect(await capture).toEqual({ kind: "timed-out" });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(timeout).toHaveBeenCalledOnce();
    } finally {
      timeout.mockRestore();
    }
  });

  it("does not publish a rasterization that completes after the capture deadline", async () => {
    const captureTimeoutController = new AbortController();
    const rasterTimeoutController = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((milliseconds) =>
        milliseconds === 5_000 ? captureTimeoutController.signal : rasterTimeoutController.signal,
      );
    let resolveRasterization!: (value: unknown) => void;
    const { webContents, executeJavaScriptInIsolatedWorld } = makeWebContents({
      rasterize: () =>
        new Promise((resolve) => {
          resolveRasterization = resolve;
        }),
    });
    try {
      const capture = captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: [SOURCE_PNG_URL],
        signal: new AbortController().signal,
      });
      await vi.waitFor(() => expect(executeJavaScriptInIsolatedWorld).toHaveBeenCalledOnce());
      captureTimeoutController.abort(new DOMException("capture timed out", "TimeoutError"));

      expect(await capture).toEqual({ kind: "timed-out" });
      resolveRasterization(PNG);
    } finally {
      timeout.mockRestore();
    }
  });

  it("cancels a stalled response body when the capture deadline expires", async () => {
    const timeoutController = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const cancel = vi.fn();
    const { webContents } = makeWebContents({
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel,
          }),
          { headers: { "content-type": "image/png" } },
        ),
    });
    try {
      const capture = captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: ["https://example.com/favicon.png"],
        signal: new AbortController().signal,
      });
      timeoutController.abort(new DOMException("capture timed out", "TimeoutError"));

      expect(await capture).toEqual({ kind: "timed-out" });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      timeout.mockRestore();
    }
  });

  it("rejects and cancels an oversized streamed response", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_FAVICON_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    const { webContents, executeJavaScriptInIsolatedWorld } = makeWebContents({
      fetch: async () => new Response(body, { headers: { "content-type": "image/png" } }),
    });

    expect(
      await captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: ["https://example.com/favicon.png"],
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: "none" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  });

  it("retains bounded compatibility with common favicon formats", async () => {
    const { webContents, executeJavaScriptInIsolatedWorld } = makeWebContents();
    for (const [mime, buffer] of [
      ["image/gif", sourceGif(32, 32)],
      ["image/jpeg", sourceJpeg(32, 32)],
      ["image/webp", sourceWebp(32, 32)],
      ["image/x-icon", sourceIco(SOURCE_PNG)],
    ] as const) {
      expect(
        await captureFavicon({
          webContents,
          pageUrl: "https://example.com/page",
          candidates: [`data:${mime};base64,${buffer.toString("base64")}`],
          signal: new AbortController().signal,
        }),
      ).toEqual({ kind: "captured", dataUrl: PNG });
    }
    expect(executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(4);
  });

  it.each([
    {
      label: "landscape",
      source: sourcePng(64, 32),
      resizeWidth: 32,
      resizeHeight: 16,
      draw: "context.drawImage(bitmap, 0, 8, 32, 16)",
    },
    {
      label: "portrait",
      source: sourcePng(32, 64),
      resizeWidth: 16,
      resizeHeight: 32,
      draw: "context.drawImage(bitmap, 8, 0, 16, 32)",
    },
  ])("preserves $label aspect ratio within the 32x32 output", async (testCase) => {
    const { webContents } = makeWebContents({
      rasterize: async (code) => {
        expect(code).toContain(`resizeWidth: ${testCase.resizeWidth}`);
        expect(code).toContain(`resizeHeight: ${testCase.resizeHeight}`);
        expect(code).toContain('resizeQuality: "high"');
        expect(code).toContain(testCase.draw);
        return PNG;
      },
    });

    expect(
      await captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: [`data:image/png;base64,${testCase.source.toString("base64")}`],
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: "captured", dataUrl: PNG });
  });

  it.each([
    ...[1, 2, 3, 4].map((orientation) => ({
      label: `keeps stored dimensions for orientation ${orientation}`,
      layout: JPEG_LANDSCAPE_LAYOUT,
      source: sourceJpeg(64, 32, orientation),
    })),
    ...[5, 6, 7, 8].map((orientation) => ({
      label: `uses display dimensions for orientation ${orientation}`,
      layout: JPEG_PORTRAIT_LAYOUT,
      source: sourceJpeg(64, 32, orientation),
    })),
    {
      label: "uses the first separate EXIF segment when it is transposed",
      layout: JPEG_PORTRAIT_LAYOUT,
      source: sourceJpeg(64, 32, [6, 1]),
    },
    {
      label: "uses the first separate EXIF segment when it is untransposed",
      layout: JPEG_LANDSCAPE_LAYOUT,
      source: sourceJpeg(64, 32, [1, 6]),
    },
    {
      label: "does not consult a later EXIF segment after an invalid orientation",
      layout: JPEG_LANDSCAPE_LAYOUT,
      source: sourceJpeg(64, 32, [9, 6]),
    },
    {
      label: "uses a later valid orientation in the same IFD",
      layout: JPEG_PORTRAIT_LAYOUT,
      source: sourceJpegWithOrientationEntries(64, 32, [9, 6]),
    },
    {
      label: "skips a non-EXIF APP1 segment",
      layout: JPEG_PORTRAIT_LAYOUT,
      source: sourceJpegWithApp1Segments(64, 32, [
        sourceJpegApp1Segment(Buffer.from("not-exif")),
        sourceJpegExifSegment([6]),
      ]),
    },
    {
      label: "skips an empty EXIF APP1 segment",
      layout: JPEG_PORTRAIT_LAYOUT,
      source: sourceJpegWithApp1Segments(64, 32, [
        sourceJpegApp1Segment(Buffer.from("Exif\0\0", "binary")),
        sourceJpegExifSegment([6]),
      ]),
    },
    {
      label: "stops after a malformed qualifying EXIF APP1 segment",
      layout: JPEG_LANDSCAPE_LAYOUT,
      source: sourceJpegWithApp1Segments(64, 32, [
        sourceJpegApp1Segment(Buffer.from("Exif\0\0broken", "binary")),
        sourceJpegExifSegment([6]),
      ]),
    },
    {
      label: "ignores the EXIF padding byte",
      layout: JPEG_PORTRAIT_LAYOUT,
      source: sourceJpegWithApp1Segments(64, 32, [sourceJpegExifSegment([6], { padding: 0xff })]),
    },
    {
      label: "reads big-endian EXIF",
      layout: JPEG_PORTRAIT_LAYOUT,
      source: sourceJpegWithApp1Segments(64, 32, [sourceJpegExifSegment([6], { byteOrder: "MM" })]),
    },
    {
      label: "matches Chromium for a nonstandard TIFF magic field",
      layout: JPEG_PORTRAIT_LAYOUT,
      source: sourceJpegWithApp1Segments(64, 32, [sourceJpegExifSegment([6], { magic: 0 })]),
    },
    {
      label: "rejects a high-bit little-endian alias",
      layout: JPEG_LANDSCAPE_LAYOUT,
      source: sourceJpegWithEndianAlias(0xc9, "II"),
    },
    {
      label: "rejects a high-bit big-endian alias",
      layout: JPEG_LANDSCAPE_LAYOUT,
      source: sourceJpegWithEndianAlias(0xcd, "MM"),
    },
    {
      label: "reads an orientation from a SubIFD",
      layout: JPEG_PORTRAIT_LAYOUT,
      source: sourceJpegWithApp1Segments(64, 32, [
        sourceJpegExifWithSubIfd({ subIfdOrientation: 6 }),
      ]),
    },
    {
      label: "uses a SubIFD orientation before a later root orientation",
      layout: JPEG_PORTRAIT_LAYOUT,
      source: sourceJpegWithApp1Segments(64, 32, [
        sourceJpegExifWithSubIfd({
          rootOrientation: 1,
          subIfdFirst: true,
          subIfdOrientation: 6,
        }),
      ]),
    },
    {
      label: "uses a root orientation before a later SubIFD orientation",
      layout: JPEG_LANDSCAPE_LAYOUT,
      source: sourceJpegWithApp1Segments(64, 32, [
        sourceJpegExifWithSubIfd({ rootOrientation: 1, subIfdOrientation: 6 }),
      ]),
    },
    {
      label: "memoizes repeated aliases to the same SubIFD",
      layout: JPEG_PORTRAIT_LAYOUT,
      source: sourceJpegWithApp1Segments(64, 32, [
        sourceJpegExifWithSubIfdPointers({ pointerCount: 32, subIfdEntries: 32 }),
      ]),
    },
  ])("matches Chromium JPEG layout: $label", async ({ source, layout }) => {
    await expectJpegLayout(source, layout);
  });

  it("rejects JPEG metadata when distinct SubIFDs exhaust the linear work budget", async () => {
    const source = sourceJpegWithApp1Segments(64, 32, [
      sourceJpegExifWithOverlappingSubIfds(32, 32),
    ]);
    const { webContents, executeJavaScriptInIsolatedWorld } = makeWebContents();

    expect(
      await captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: [`data:image/jpeg;base64,${source.toString("base64")}`],
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: "none" });
    expect(executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  });

  it("rejects JPEGs with multiple frame headers before rasterization", async () => {
    const buffer = Buffer.concat([sourceJpeg(4096, 4096), sourceJpeg(1, 1).subarray(2)]);
    const { webContents, executeJavaScriptInIsolatedWorld } = makeWebContents();

    expect(
      await captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: [`data:image/jpeg;base64,${buffer.toString("base64")}`],
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: "none" });
    expect(executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  });

  it("rejects an unsafe PNG size before rasterization", async () => {
    const buffer = makeUnsafePng();
    const { webContents, executeJavaScriptInIsolatedWorld } = makeWebContents({
      fetch: async () =>
        new Response(new Uint8Array(buffer), {
          headers: { "content-type": "image/png" },
        }),
    });

    expect(
      await captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: ["https://example.com/favicon.png"],
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: "none" });
    expect(executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  });

  it.each([
    ["GIF", "image/gif", sourceGif(4096, 4096)],
    ["GIF frame", "image/gif", sourceGif(1, 1, 4096, 4096)],
    ["GIF later frame", "image/gif", sourceGif(1, 1, 1, 1, [{ width: 4096, height: 4096 }])],
    [
      "GIF cumulative frames",
      "image/gif",
      sourceGif(
        64,
        64,
        64,
        64,
        Array.from({ length: 256 }, () => ({ width: 64, height: 64 })),
      ),
    ],
    ["JPEG", "image/jpeg", sourceJpeg(4096, 4096)],
    ["WebP", "image/webp", sourceWebp(4096, 4096)],
    ["ICO with PNG", "image/x-icon", sourceIco(makeUnsafePng())],
    ["ICO with DIB", "image/x-icon", sourceIco(makeUnsafeDib())],
    ["SVG", "image/svg+xml", Buffer.from('<svg width="1" height="1"/>')],
    [
      "SVG with embedded bitmap",
      "image/svg+xml",
      Buffer.from(
        `<svg width="1" height="1"><image href="data:image/png;base64,${makeUnsafePng().toString("base64")}"/></svg>`,
      ),
    ],
    [
      "ICO invalid payload span",
      "image/x-icon",
      (() => {
        const buffer = Buffer.alloc(22);
        buffer.writeUInt16LE(1, 2);
        buffer.writeUInt16LE(1, 4);
        buffer.writeUInt32LE(100, 14);
        buffer.writeUInt32LE(22, 18);
        return buffer;
      })(),
    ],
  ])("rejects unsafe or unsupported %s before rasterization", async (_label, mime, buffer) => {
    const { webContents, executeJavaScriptInIsolatedWorld } = makeWebContents();
    const candidate = `data:${mime};base64,${buffer.toString("base64")}`;
    expect(
      await captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: [candidate],
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: "none" });
    expect(executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  });

  it("ignores output that is not a bounded PNG data URL", async () => {
    const { webContents } = makeWebContents({
      rasterize: async () => "data:image/svg+xml;base64,c3Zn",
    });

    expect(
      await captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: [SOURCE_PNG_URL],
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: "none" });
  });

  it("waits for physical rasterization settlement after a logical timeout", async () => {
    vi.useFakeTimers();
    try {
      let resolveOld!: (value: unknown) => void;
      let executions = 0;
      const { webContents } = makeWebContents({
        rasterize: () => {
          executions += 1;
          return executions === 1
            ? new Promise((resolve) => {
                resolveOld = resolve;
              })
            : Promise.resolve(PNG);
        },
      });
      const input = {
        webContents,
        pageUrl: "https://example.com/page",
        candidates: [SOURCE_PNG_URL],
        signal: new AbortController().signal,
      };
      const timedOut = captureFavicon(input);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(await timedOut).toEqual({ kind: "timed-out" });

      const newer = captureFavicon(input);
      await Promise.resolve();
      expect(executions).toBe(1);
      resolveOld(PNG);
      expect(await newer).toEqual({ kind: "captured", dataUrl: PNG });
      expect(executions).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends candidate fallback after a rasterization timeout", async () => {
    vi.useFakeTimers();
    try {
      let resolveRasterization!: (value: unknown) => void;
      const { webContents, fetch, executeJavaScriptInIsolatedWorld } = makeWebContents({
        rasterize: () =>
          new Promise((resolve) => {
            resolveRasterization = resolve;
          }),
      });
      const capture = captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: ["https://example.com/first.png", "https://example.com/second.png"],
        signal: new AbortController().signal,
      });

      await vi.advanceTimersByTimeAsync(1_001);

      expect(await capture).toEqual({ kind: "timed-out" });
      expect(fetch).toHaveBeenCalledOnce();
      expect(executeJavaScriptInIsolatedWorld).toHaveBeenCalledOnce();
      resolveRasterization(PNG);
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces queued rasterizations so only the latest pending capture launches", async () => {
    let resolveFirst!: (value: unknown) => void;
    let executions = 0;
    const { webContents } = makeWebContents({
      rasterize: () => {
        executions += 1;
        return executions === 1
          ? new Promise((resolve) => {
              resolveFirst = resolve;
            })
          : Promise.resolve(PNG);
      },
    });
    const input = {
      webContents,
      pageUrl: "https://example.com/page",
      candidates: [SOURCE_PNG_URL],
      signal: new AbortController().signal,
    };
    const first = captureFavicon(input);
    const superseded = captureFavicon(input);
    const newest = captureFavicon(input);

    expect(executions).toBe(1);
    resolveFirst(PNG);
    expect(await first).toEqual({ kind: "captured", dataUrl: PNG });
    expect(await superseded).toEqual({ kind: "none" });
    expect(await newest).toEqual({ kind: "captured", dataUrl: PNG });
    expect(executions).toBe(2);
  });
});
