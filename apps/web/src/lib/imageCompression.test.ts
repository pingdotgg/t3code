import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  compressImageForStash,
  compressImageToByteLimit,
  MAX_COMPRESSIBLE_SOURCE_BYTES,
  MAX_STASH_IMAGE_DATA_URL_CHARS,
  prepareImageForAttachment,
} from "./imageCompression";

import type { SnapShotSource } from "@t3tools/contracts";
import { hydrateImagesFromPersisted } from "../composerDraftStore";
import { resizeSnapShotSource } from "./snapShotSource";

const mocks = vi.hoisted(() => ({
  heicTo: vi.fn(),
}));

vi.mock("heic-to/csp", () => ({
  heicTo: mocks.heicTo,
}));

const originalCreateImageBitmap = globalThis.createImageBitmap;
const originalOffscreenCanvas = globalThis.OffscreenCanvas;

beforeEach(() => {
  vi.stubGlobal(
    "FileReader",
    class extends EventTarget {
      result: string | null = null;
      error: unknown = null;
      async readAsDataURL(blob: Blob) {
        try {
          const bytes = await blob.arrayBuffer();
          this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(bytes).toString("base64")}`;
          this.dispatchEvent(new Event("load"));
        } catch (error) {
          this.error = error;
          this.dispatchEvent(new Event("error"));
        }
      }
    },
  );
});

function makeFile(sizeBytes: number, type = "image/png"): File {
  return new File([new Uint8Array(sizeBytes).fill(7)], "shot.png", { type });
}

function makeHeicFile(options?: {
  name?: string;
  type?: string;
  width?: number;
  height?: number;
  lastModified?: number;
}): File {
  const encoder = new TextEncoder();
  const makeBox = (name: string, ...contents: Uint8Array[]) => {
    const bytes = new Uint8Array(8 + contents.reduce((size, content) => size + content.length, 0));
    new DataView(bytes.buffer).setUint32(0, bytes.length);
    bytes.set(encoder.encode(name), 4);
    let offset = 8;
    for (const content of contents) {
      bytes.set(content, offset);
      offset += content.length;
    }
    return bytes;
  };

  const dimensions = new Uint8Array(12);
  const view = new DataView(dimensions.buffer);
  view.setUint32(4, options?.width ?? 4000);
  view.setUint32(8, options?.height ?? 3000);
  const properties = makeBox("iprp", makeBox("ipco", makeBox("ispe", dimensions)));

  return new File(
    [
      makeBox("ftyp", encoder.encode("heic"), new Uint8Array(4)),
      makeBox("meta", new Uint8Array(4), properties),
    ],
    options?.name ?? "photo.heic",
    {
      type: options?.type ?? "image/heic",
      ...(options?.lastModified !== undefined ? { lastModified: options.lastModified } : {}),
    },
  );
}

function stubCanvasPipeline(
  sizeForQuality: (quality: number) => number,
  options?: { supportsWebp?: boolean; htmlCanvas?: boolean },
) {
  const supportsWebp = options?.supportsWebp ?? true;
  const close = vi.fn();
  const fillRect = vi.fn();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 4000, height: 3000, close })),
  );
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return {
          fillStyle: "",
          fillRect,
          drawImage: vi.fn(),
        };
      }
      async convertToBlob({ type, quality }: { type: string; quality: number }) {
        const resolvedType = type === "image/webp" && !supportsWebp ? "image/png" : type;
        return new Blob([new Uint8Array(sizeForQuality(quality))], { type: resolvedType });
      }
    },
  );
  if (options?.htmlCanvas) {
    const Canvas = globalThis.OffscreenCanvas;
    class HtmlCanvas extends Canvas {
      toBlob(callback: BlobCallback, type: string, quality: number) {
        void this.convertToBlob({ type, quality }).then(callback);
      }
    }
    vi.stubGlobal("OffscreenCanvas", undefined);
    vi.stubGlobal("HTMLCanvasElement", HtmlCanvas);
    vi.stubGlobal("document", { createElement: () => new HtmlCanvas(0, 0) });
  }
  return { close, fillRect };
}

afterEach(() => {
  mocks.heicTo.mockReset();
  vi.unstubAllGlobals();
  globalThis.createImageBitmap = originalCreateImageBitmap;
  globalThis.OffscreenCanvas = originalOffscreenCanvas;
});

describe("compressImageForStash", () => {
  it("keeps the exact data URL budget boundary and original bytes", async () => {
    const original = makeFile(3);
    const dataUrl = "data:image/png;base64,BwcH";

    const result = await compressImageForStash(original, dataUrl.length);

    expect(result.ok && result.image.dataUrl).toBe(dataUrl);
    expect(result.ok && result.image.recompressed).toBe(false);
    expect(await compressImageForStash(original, dataUrl.length - 1)).toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  it("compresses an oversized source before reading it as a data URL", async () => {
    stubCanvasPipeline(() => 120_000);
    const original = makeFile(4_000_000);
    const read = vi.spyOn(original, "arrayBuffer").mockRejectedValue(new Error("unneeded read"));

    const result = await compressImageForStash(original);

    expect(result.ok && result.image.recompressed).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it("re-encodes an oversized image to WebP within the budget", async () => {
    const { close, fillRect } = stubCanvasPipeline(() => 120_000);

    const result = await compressImageForStash(makeFile(4_000_000));

    expect(result.ok).toBe(true);
    expect(result.ok && result.image.recompressed).toBe(true);
    expect(result.ok && result.image.mimeType).toBe("image/webp");
    expect(result.ok && result.image.dataUrl.length <= MAX_STASH_IMAGE_DATA_URL_CHARS).toBe(true);
    expect(result.ok && result.image.sizeBytes).toBeLessThan(4_000_000);
    expect(fillRect).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("falls back to JPEG with a white matte when WebP encoding is unavailable", async () => {
    const { fillRect } = stubCanvasPipeline(() => 120_000, { supportsWebp: false });

    const result = await compressImageForStash(makeFile(4_000_000));

    expect(result.ok && result.image.recompressed).toBe(true);
    expect(result.ok && result.image.mimeType).toBe("image/jpeg");
    expect(fillRect).toHaveBeenCalled();
  });

  it("steps quality down until the encoded image fits", async () => {
    const { close } = stubCanvasPipeline((quality) => (quality <= 0.68 ? 400_000 : 3_000_000));

    const result = await compressImageForStash(makeFile(9_000_000));

    expect(result.ok && result.image.recompressed).toBe(true);
    expect(result.ok && result.image.dataUrl.length <= MAX_STASH_IMAGE_DATA_URL_CHARS).toBe(true);
    expect(close).toHaveBeenCalled();
  });

  it("reports too-large when even the smallest encoding overflows the budget", async () => {
    const { close } = stubCanvasPipeline(() => 8_000_000);

    const result = await compressImageForStash(makeFile(9_000_000));

    expect(result).toEqual({ ok: false, reason: "too-large" });
    expect(close).toHaveBeenCalled();
  });

  it("reports unreadable when the image fails to decode", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new Error("corrupt image");
      }),
    );
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return null;
        }
      },
    );

    expect(await compressImageForStash(makeFile(4_000_000))).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  it("compressImageToByteLimit refuses sources above the decode-safety ceiling", async () => {
    const bitmapSpy = vi.fn();
    vi.stubGlobal("createImageBitmap", bitmapSpy);

    const result = await compressImageToByteLimit(
      makeFile(MAX_COMPRESSIBLE_SOURCE_BYTES + 1),
      10 * 1024 * 1024,
    );

    expect(result).toEqual({ ok: false, reason: "too-large" });
    expect(bitmapSpy).not.toHaveBeenCalled();
  });
});

describe("HEIC attachment preparation", () => {
  it("converts a HEIC photo with a missing MIME type into a named JPEG", async () => {
    const original = makeHeicFile({
      name: "IMG_1234.HEIC",
      type: "",
      lastModified: 123,
    });
    mocks.heicTo.mockResolvedValueOnce(
      new Blob([new Uint8Array([4, 5, 6, 7])], { type: "image/jpeg" }),
    );

    const result = await prepareImageForAttachment(original, 1024);

    expect(mocks.heicTo).toHaveBeenCalledWith({
      blob: original,
      type: "image/jpeg",
      quality: 0.92,
    });
    expect(result.ok && result.file.name).toBe("IMG_1234.jpg");
    expect(result.ok && result.file.type).toBe("image/jpeg");
    expect(result.ok && result.file.size).toBe(4);
    expect(result.ok && result.file.lastModified).toBe(123);
    expect(result.ok && result.recompressed).toBe(true);
  });

  it("compresses JPEG intermediates above the source safety ceiling", async () => {
    const original = makeHeicFile({
      name: "large.heic",
      type: "image/heic",
    });
    mocks.heicTo.mockResolvedValueOnce(
      new Blob([new Uint8Array(MAX_COMPRESSIBLE_SOURCE_BYTES + 1)], {
        type: "image/jpeg",
      }),
    );
    const { close } = stubCanvasPipeline(() => 200_000);

    const result = await prepareImageForAttachment(original, 1_000_000);

    expect(result.ok && result.file.name).toBe("large.jpg");
    expect(result.ok && result.file.type).toBe("image/jpeg");
    expect(result.ok && result.file.size).toBeLessThanOrEqual(1_000_000);
    expect(close).toHaveBeenCalled();
  });

  it("rejects oversized HEIC dimensions before loading the decoder", async () => {
    const original = makeHeicFile({ width: 16_000, height: 4001 });

    expect(await prepareImageForAttachment(original, 1024)).toEqual({
      ok: false,
      reason: "too-large",
    });
    expect(mocks.heicTo).not.toHaveBeenCalled();
  });

  it("rejects unsafe HEIC sources before loading the decoder", async () => {
    const original = new File(["photo"], "large.heic", { type: "image/heic" });
    Object.defineProperty(original, "size", { value: MAX_COMPRESSIBLE_SOURCE_BYTES + 1 });

    expect(await prepareImageForAttachment(original, 1024)).toEqual({
      ok: false,
      reason: "too-large",
    });
    expect(mocks.heicTo).not.toHaveBeenCalled();
  });
});

describe("attachment max edge", () => {
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const u16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff];
  const pngHeader = (width: number, height: number) => [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32(13),
    0x49,
    0x48,
    0x44,
    0x52,
    ...u32(width),
    ...u32(height),
    8,
    6,
    0,
    0,
    0,
  ];
  const jpegHeader = (width: number, height: number) => [
    0xff,
    0xd8,
    0xff,
    0xc0,
    ...u16(17),
    8,
    ...u16(height),
    ...u16(width),
  ];
  const image = (header: number[], name: string, type: string) =>
    new File([new Uint8Array([...header, ...new Uint8Array(2048).fill(7)])], name, { type });

  function stubDecoder(bitmapSize: { width: number; height: number }) {
    const decode = vi.fn(async () => ({ ...bitmapSize, close: vi.fn() }));
    const canvases: Array<{ width: number; height: number }> = [];
    const encodes: Array<{ type: string; quality: number }> = [];
    const fillRect = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor(width: number, height: number) {
          canvases.push({ width, height });
        }
        getContext() {
          return { fillRect, drawImage: vi.fn() };
        }
        async convertToBlob(options: { type: string; quality: number }) {
          encodes.push(options);
          return new Blob([new Uint8Array(500_000)], { type: options.type });
        }
      },
    );
    return { decode, canvases, encodes, fillRect };
  }

  it("scales a large PNG screenshot under the byte cap to 2000px and keeps it a PNG", async () => {
    const { decode, canvases, encodes, fillRect } = stubDecoder({ width: 3024, height: 1964 });
    const original = image(pngHeader(3024, 1964), "shot.png", "image/png");

    const result = await prepareImageForAttachment(original, 10 * 1024 * 1024);

    expect(decode).toHaveBeenCalledExactlyOnceWith(original, { imageOrientation: "from-image" });
    expect(canvases).toEqual([{ width: 2000, height: 1299 }]);
    expect(encodes.map(({ type }) => type)).toEqual(["image/png"]);
    expect(fillRect).not.toHaveBeenCalled();
    expect(result.ok && result.recompressed).toBe(true);
    expect(result.ok && result.imageSize).toEqual({ width: 2000, height: 1299 });
    expect(result.ok && result.file.name).toBe("shot.png");
    expect(result.ok && result.file.type).toBe("image/png");
  });

  it("scales a rotated JPEG by its displayed size and keeps it a JPEG", async () => {
    const { canvases, encodes } = stubDecoder({ width: 3024, height: 4032 });
    const original = image(jpegHeader(4032, 3024), "photo.jpg", "image/jpeg");

    const result = await prepareImageForAttachment(original, 10 * 1024 * 1024);

    expect(canvases).toEqual([{ width: 1500, height: 2000 }]);
    expect(encodes).toEqual([{ type: "image/jpeg", quality: 0.92 }]);
    expect(result.ok && result.file.type).toBe("image/jpeg");
    expect(result.ok && result.imageSize).toEqual({ width: 1500, height: 2000 });
  });

  it.each([
    { label: "a 2000px PNG", header: pngHeader(2000, 1200), type: "image/png" },
    {
      label: "a 3000px GIF",
      header: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0xb8, 0x0b, 0x10, 0x04],
      type: "image/gif",
    },
  ])("passes $label through without decoding it", async ({ header, type }) => {
    const { decode } = stubDecoder({ width: 3000, height: 1040 });
    const original = image(header, "image", type);

    const result = await prepareImageForAttachment(original, 10 * 1024 * 1024);

    expect(result.ok && result.file).toBe(original);
    expect(result.ok && result.recompressed).toBe(false);
    expect(decode).not.toHaveBeenCalled();
  });
});

describe("snapshot coordinates after compression", () => {
  const source: SnapShotSource = {
    kind: "snap-shot",
    capturedAt: "2026-09-01T00:00:00.000Z",
    appName: "Editor",
    windowTitle: "main.ts",
    accessibility: {
      format: "element-tree",
      coordinateSpace: "captured-image",
      imageSize: { width: 2560, height: 1600 },
      truncated: false,
      root: {
        role: "window",
        bounds: { x: 0, y: 0, width: 2560, height: 1600 },
        children: [
          {
            role: "button",
            name: "Save",
            bounds: { x: 2400, y: 1400, width: 100, height: 100 },
            children: [],
          },
          { role: "static_text", name: "Untitled", bounds: null, children: [] },
        ],
      },
    },
  };

  it.each(["stash", "delivery"])(
    "rescales the source and restores it with the compressed %s image",
    async (path) => {
      stubCanvasPipeline(() => 100);
      vi.stubGlobal(
        "createImageBitmap",
        vi.fn(async () => ({ width: 2560, height: 1600, close: vi.fn() })),
      );
      const original = makeFile(2000);
      const compressed =
        path === "stash"
          ? await compressImageForStash(original, 1000)
          : await compressImageToByteLimit(original, 1000);
      expect(compressed.ok).toBe(true);
      if (!compressed.ok) throw new Error("Compression failed");
      const image =
        "image" in compressed
          ? compressed.image
          : {
              ...compressed,
              mimeType: compressed.file.type,
              sizeBytes: compressed.file.size,
              dataUrl: `data:${compressed.file.type};base64,${Buffer.from(await compressed.file.arrayBuffer()).toString("base64")}`,
            };
      expect(image.imageSize).toEqual({ width: 2000, height: 1250 });
      const resized = resizeSnapShotSource(source, image.imageSize);
      const [restored] = hydrateImagesFromPersisted([
        {
          id: "capture",
          name: "window.webp",
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          dataUrl: image.dataUrl,
          source: resized,
        },
      ]);
      expect(restored?.source?.accessibility).toMatchObject({
        imageSize: { width: 2000, height: 1250 },
        root: {
          bounds: { x: 0, y: 0, width: 2000, height: 1250 },
          children: [{ bounds: { x: 1875, y: 1094, width: 78, height: 78 } }, { bounds: null }],
        },
      });
      expect(source.accessibility).toMatchObject({ imageSize: { width: 2560, height: 1600 } });
    },
  );
});
