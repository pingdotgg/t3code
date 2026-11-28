import { beforeEach, expect, it, vi } from "vite-plus/test";
import type * as Electron from "electron";
import { copyContextMenuImage, copySourcePng } from "./ContextMenuImage.ts";

const native = vi.hoisted(() => ({
  fetch: vi.fn(),
  createFromBuffer: vi.fn(),
  write: vi.fn(),
  image: {
    isEmpty: vi.fn(() => false),
    toPNG: vi.fn(() => Buffer.from("png")),
    getSize: vi.fn(() => ({ width: 1, height: 2 })),
    toBitmap: vi.fn(() => Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])),
  },
}));

vi.mock("electron", () => ({
  net: { fetch: native.fetch },
  nativeImage: { createFromBuffer: native.createFromBuffer },
  clipboard: { write: native.write },
  ClipboardItem: class {
    readonly blobs: Record<string, Blob>;
    constructor(blobs: Record<string, Blob>) {
      this.blobs = blobs;
    }
  },
}));

const mainFrame = { isDestroyed: vi.fn(() => false) };
const frame = { isDestroyed: vi.fn(() => false) };
const contents = {
  isDestroyed: vi.fn(() => false),
  copyImageAt: vi.fn(),
  executeJavaScriptInIsolatedWorld: vi.fn(),
  mainFrame,
};
const params = {
  x: 12,
  y: 34,
  srcURL: "https://example.com/image.png",
  frame,
};
const sourcePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFklEQVR4nGP4TyFgGDVg1IBRA4aLAQBdePwur/3haQAAAABJRU5ErkJggg==",
  "base64",
);

const rawFormat = (name: string) => `electron application/osclipboard;format="${name}"`;
const writtenBlobs = () => native.write.mock.calls[0]?.[0][0].blobs as Record<string, Blob>;
const blobBytes = async (blob: Blob | undefined) =>
  Buffer.from(new Uint8Array((await blob?.arrayBuffer()) ?? new ArrayBuffer(0)));
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAkQBADs=", "base64");

const copyImage = (overrides: Partial<typeof params> = {}, platform: NodeJS.Platform = "linux") =>
  copyContextMenuImage(
    contents as unknown as Electron.WebContents,
    { ...params, ...overrides } as unknown as Electron.ContextMenuParams,
    platform,
  );

beforeEach(() => {
  vi.clearAllMocks();
  contents.isDestroyed.mockReturnValue(false);
  frame.isDestroyed.mockReturnValue(false);
  native.image.isEmpty.mockReturnValue(false);
  native.createFromBuffer.mockReturnValue(native.image);
  native.fetch.mockResolvedValue(new Response(Uint8Array.from(sourcePng)));
  native.write.mockResolvedValue(undefined);
  contents.executeJavaScriptInIsolatedWorld.mockRejectedValue(
    new Error("Image could not be decoded"),
  );
});

it.each(["https://example.com/image.png", `data:image/png;base64,${sourcePng.toString("base64")}`])(
  "copies an iframe image from %s",
  async (srcURL) => {
    await copyImage({ srcURL });
    if (srcURL.startsWith("https:")) {
      expect(native.fetch).toHaveBeenCalledWith(srcURL, {
        credentials: "omit",
        redirect: "error",
        signal: expect.any(AbortSignal),
      });
    } else {
      expect(native.fetch).not.toHaveBeenCalled();
    }
    expect(contents.copyImageAt).not.toHaveBeenCalled();
    expect(native.createFromBuffer).toHaveBeenCalledWith(sourcePng);
    expect(native.image.toPNG).not.toHaveBeenCalled();
    expect(await blobBytes(writtenBlobs()[rawFormat("image/png")])).toEqual(sourcePng);
  },
);

it("re-encodes an iframe image that is not a PNG", async () => {
  native.fetch.mockResolvedValue(new Response(Uint8Array.from(gif)));
  await copyImage();
  expect(await blobBytes(writtenBlobs()["image/png"])).toEqual(Buffer.from("png"));
});

it.each([
  ["linux", rawFormat("image/png")],
  ["darwin", rawFormat("public.png")],
  ["win32", "PNG"],
] as const)("copies a main-frame PNG unchanged on %s", async (platform, format) => {
  await copyImage({ frame: mainFrame }, platform);
  expect(contents.copyImageAt).not.toHaveBeenCalled();
  const blobs = writtenBlobs();
  expect(blobs["image/png"]).toBeUndefined();
  expect(await blobBytes(blobs[format])).toEqual(sourcePng);
  if (platform !== "win32") return expect(Object.keys(blobs)).toEqual([format]);
  // Windows pastes need a bitmap beside the PNG: bottom-up rows after a BITMAPV5HEADER.
  const dib = await blobBytes(blobs[rawFormat("#17")]);
  expect([dib.readUInt32LE(0), dib.readInt32LE(4), dib.readInt32LE(8)]).toEqual([124, 1, 2]);
  expect([...dib.subarray(124)]).toEqual([5, 6, 7, 8, 1, 2, 3, 4]);
});

it.each([
  ["is not a PNG", () => native.fetch.mockResolvedValue(new Response(Uint8Array.from(gif)))],
  ["cannot be read", () => native.fetch.mockRejectedValue(new Error("offline"))],
])("copies the rendered bitmap when a main-frame image %s", async (_, arrange) => {
  arrange();
  await copyImage({ frame: mainFrame });
  expect(contents.copyImageAt).toHaveBeenCalledWith(12, 34);
  expect(native.write).not.toHaveBeenCalled();
});

it("refuses bytes that are not a decodable PNG", async () => {
  expect(await copySourcePng(gif, "linux")).toBe(false);
  native.image.isEmpty.mockReturnValue(true);
  expect(await copySourcePng(sourcePng, "linux")).toBe(false);
  expect(native.write).not.toHaveBeenCalled();
});

it.each([
  ["WebP", "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA="],
  ["GIF", "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAkQBADs="],
])("copies %s using Chromium when nativeImage cannot decode it", async (_, base64) => {
  native.fetch.mockResolvedValue(new Response(Uint8Array.from(Buffer.from(base64, "base64"))));
  native.image.isEmpty.mockReturnValue(true);
  contents.executeJavaScriptInIsolatedWorld.mockResolvedValue(Uint8Array.from(sourcePng).buffer);
  await copyImage();
  const blob = native.write.mock.calls[0]?.[0][0].blobs["image/png"] as Blob;
  expect(Buffer.from(await blob.arrayBuffer())).toEqual(sourcePng);
  expect(native.image.toPNG).not.toHaveBeenCalled();
});

it("preserves the clipboard if the source frame closes during Chromium decoding", async () => {
  native.image.isEmpty.mockReturnValue(true);
  contents.executeJavaScriptInIsolatedWorld.mockImplementation(() => {
    frame.isDestroyed.mockReturnValue(true);
    return Promise.resolve(Uint8Array.from(sourcePng).buffer);
  });
  await copyImage();
  expect(native.write).not.toHaveBeenCalled();
});

it("copies a GIF larger than the favicon pixel limit", async () => {
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAkQBADs=", "base64");
  gif.writeUInt16LE(2048, 6);
  gif.writeUInt16LE(1024, 8);
  native.fetch.mockResolvedValue(new Response(Uint8Array.from(gif)));
  native.image.isEmpty.mockReturnValue(true);
  contents.executeJavaScriptInIsolatedWorld.mockResolvedValue(Uint8Array.from(sourcePng).buffer);
  await copyImage();
  const blob = native.write.mock.calls[0]?.[0][0].blobs["image/png"] as Blob;
  expect(Buffer.from(await blob.arrayBuffer())).toEqual(sourcePng);
});

it.each([
  "file:///private/image.png",
  "blob:https://example.com/image",
  "https://user:pass@example.com/image.png",
])("rejects unsupported or credential-bearing URLs: %s", async (srcURL) => {
  await expect(copyImage({ srcURL })).rejects.toThrow("Unsupported image URL");
  expect(native.fetch).not.toHaveBeenCalled();
  expect(native.write).not.toHaveBeenCalled();
});

it("cancels responses whose declared size exceeds the limit", async () => {
  const cancel = vi.fn();
  native.fetch.mockResolvedValue(
    new Response(new ReadableStream({ cancel }), {
      headers: { "content-length": String(32 * 1024 * 1024 + 1) },
    }),
  );
  await expect(copyImage()).rejects.toThrow("size limit");
  expect(cancel).toHaveBeenCalled();
  expect(native.createFromBuffer).not.toHaveBeenCalled();
});

it("cancels oversized streams without a content-length", async () => {
  const cancel = vi.fn();
  native.fetch.mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(32 * 1024 * 1024));
          controller.enqueue(new Uint8Array(1));
        },
        cancel,
      }),
    ),
  );
  await expect(copyImage()).rejects.toThrow("size limit");
  expect(cancel).toHaveBeenCalled();
  expect(native.write).not.toHaveBeenCalled();
});

it("preserves the clipboard when the response is not an image", async () => {
  native.image.isEmpty.mockReturnValue(true);
  await expect(copyImage()).rejects.toThrow("could not be decoded");
  expect(native.write).not.toHaveBeenCalled();
});

it("rejects large decoded dimensions before image allocation", async () => {
  const oversizedPng = Buffer.from(sourcePng);
  oversizedPng.writeUInt32BE(4096, 16);
  oversizedPng.writeUInt32BE(4096, 20);
  native.fetch.mockResolvedValue(new Response(Uint8Array.from(oversizedPng)));
  await expect(copyImage()).rejects.toThrow("size limit");
  expect(native.createFromBuffer).not.toHaveBeenCalled();
  expect(native.image.toPNG).not.toHaveBeenCalled();
  expect(native.write).not.toHaveBeenCalled();
});

it("preserves the clipboard when the encoded PNG exceeds the limit", async () => {
  native.fetch.mockResolvedValue(new Response(Uint8Array.from(gif)));
  native.image.toPNG.mockReturnValueOnce(Buffer.alloc(32 * 1024 * 1024 + 1));
  await expect(copyImage()).rejects.toThrow("size limit");
  expect(native.write).not.toHaveBeenCalled();
});

it("does not copy after the source frame closes during the request", async () => {
  native.fetch.mockImplementation(() => {
    frame.isDestroyed.mockReturnValue(true);
    return Promise.resolve(new Response(Uint8Array.from(sourcePng)));
  });
  await copyImage();
  expect(native.write).not.toHaveBeenCalled();
});
