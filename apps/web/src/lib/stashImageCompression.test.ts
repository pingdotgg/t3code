import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { compressImageForStash, MAX_STASH_IMAGE_DATA_URL_CHARS } from "./stashImageCompression";

/**
 * jsdom has no real canvas/codec, so the re-encode path is exercised with
 * stubbed `createImageBitmap` + `OffscreenCanvas`. The encoder stub returns a
 * payload whose size scales with quality, mirroring how a real JPEG encoder
 * shrinks as quality drops — enough to verify the ladder logic and budget
 * enforcement without pulling in a native canvas.
 */

const originalCreateImageBitmap = globalThis.createImageBitmap;
const originalOffscreenCanvas = globalThis.OffscreenCanvas;

function makeFile(sizeBytes: number, type = "image/png"): File {
  return new File([new Uint8Array(sizeBytes).fill(7)], "shot.png", { type });
}

/**
 * Installs a fake bitmap + canvas whose encoded size follows `sizeForQuality`.
 * `supportsWebp: false` makes `convertToBlob` hand back a differently-typed
 * blob for WebP requests, which is how a real browser signals it cannot
 * encode that format.
 */
function stubCanvasPipeline(
  sizeForQuality: (quality: number) => number,
  options?: { supportsWebp?: boolean },
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
  return { close, fillRect };
}

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.createImageBitmap = originalCreateImageBitmap;
  globalThis.OffscreenCanvas = originalOffscreenCanvas;
});

describe("compressImageForStash", () => {
  it("stores a small image verbatim without re-encoding", async () => {
    const bitmapSpy = vi.fn();
    vi.stubGlobal("createImageBitmap", bitmapSpy);

    const result = await compressImageForStash(makeFile(1024));

    expect(result).not.toBeNull();
    expect(result?.recompressed).toBe(false);
    expect(result?.mimeType).toBe("image/png");
    expect(result?.dataUrl.startsWith("data:image/png")).toBe(true);
    // Untouched payloads must not pay for a decode.
    expect(bitmapSpy).not.toHaveBeenCalled();
  });

  it("re-encodes an oversized image to WebP within the budget", async () => {
    // Comfortably under budget at the very first quality step.
    const { close, fillRect } = stubCanvasPipeline(() => 120_000);

    const result = await compressImageForStash(makeFile(4_000_000));

    expect(result).not.toBeNull();
    expect(result?.recompressed).toBe(true);
    expect(result?.mimeType).toBe("image/webp");
    expect(result?.dataUrl.length).toBeLessThanOrEqual(MAX_STASH_IMAGE_DATA_URL_CHARS);
    // sizeBytes should describe the re-encoded payload, not the 4MB original.
    expect(result?.sizeBytes).toBeLessThan(4_000_000);
    // WebP keeps alpha, so no white matte should be painted.
    expect(fillRect).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("falls back to JPEG with a white matte when WebP encoding is unavailable", async () => {
    const { fillRect } = stubCanvasPipeline(() => 120_000, { supportsWebp: false });

    const result = await compressImageForStash(makeFile(4_000_000));

    expect(result?.recompressed).toBe(true);
    expect(result?.mimeType).toBe("image/jpeg");
    // JPEG has no alpha, so transparent regions must be matted white.
    expect(fillRect).toHaveBeenCalled();
  });

  it("steps quality down until the encoded image fits", async () => {
    // Only the lowest quality step (0.68) lands under the budget.
    const { close } = stubCanvasPipeline((quality) => (quality <= 0.68 ? 400_000 : 3_000_000));

    const result = await compressImageForStash(makeFile(9_000_000));

    expect(result?.recompressed).toBe(true);
    expect(result?.dataUrl.length).toBeLessThanOrEqual(MAX_STASH_IMAGE_DATA_URL_CHARS);
    expect(close).toHaveBeenCalled();
  });

  it("returns null when even the smallest encoding overflows the budget", async () => {
    const { close } = stubCanvasPipeline(() => 8_000_000);

    const result = await compressImageForStash(makeFile(9_000_000));

    expect(result).toBeNull();
    // The bitmap must still be released on the give-up path.
    expect(close).toHaveBeenCalled();
  });

  it("returns null for an oversized image when the browser cannot re-encode", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    vi.stubGlobal("OffscreenCanvas", undefined);

    expect(await compressImageForStash(makeFile(4_000_000))).toBeNull();
  });

  it("returns null when the image fails to decode", async () => {
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

    expect(await compressImageForStash(makeFile(4_000_000))).toBeNull();
  });
});
