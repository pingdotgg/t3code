import { describe, expect, it } from "vite-plus/test";

import heicUrl from "../../test/fixtures/images/photo.heic?url";
import {
  compressImageForStash,
  dataUrlToFile,
  prepareImageForAttachment,
  readFileAsDataUrl,
} from "./imageCompression";

async function makeImage(
  colorSpace: PredefinedColorSpace,
  fill: string,
  type: string,
  { width = 2400, height = 1600, colorType = "unorm8" } = {},
): Promise<File> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { colorSpace, colorType });
  if (!context) throw new Error("no 2d context");
  context.fillStyle = fill;
  context.fillRect(0, 0, width, height);
  const blob = await canvas.convertToBlob({ type, quality: 0.95 });
  return new File([blob], `shot.${type.slice(6)}`, { type });
}

/** `raw` ignores any embedded profile, as a reader without color management would. */
async function readPixel(file: Blob, raw = false): Promise<number[]> {
  const bitmap = await createImageBitmap(file, { colorSpaceConversion: raw ? "none" : "default" });
  const colorSpace = raw ? "srgb" : "display-p3";
  const canvas = new OffscreenCanvas(1, 1);
  const context = canvas.getContext("2d", { colorSpace });
  if (!context) throw new Error("no 2d context");
  context.drawImage(bitmap, 0, 0, 1, 1);
  bitmap.close();
  return Array.from(context.getImageData(0, 0, 1, 1, { colorSpace }).data.slice(0, 3));
}

async function expectSameColors(actual: Blob, expected: Blob) {
  expectNear(await readPixel(actual), await readPixel(expected));
  expectNear(await readPixel(actual, true), await readPixel(expected, true));
}

function expectNear(actual: number[], expected: number[]) {
  expected.forEach((channel, index) =>
    expect(Math.abs(actual[index]! - channel)).toBeLessThanOrEqual(2),
  );
}

async function readChromiumDisplayP3Profile(): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(1, 1);
  canvas.getContext("2d", { colorSpace: "display-p3" });
  const png = new Uint8Array(
    await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer(),
  );
  const view = new DataView(png.buffer);
  for (let offset = 8; offset < png.length; offset += 12 + view.getUint32(offset)) {
    if (new TextDecoder().decode(png.subarray(offset + 4, offset + 8)) !== "iCCP") continue;
    const chunk = png.subarray(offset + 8, offset + 8 + view.getUint32(offset));
    const deflated = chunk.subarray(chunk.indexOf(0) + 2);
    const inflate = new Blob([deflated]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(inflate).arrayBuffer());
  }
  throw new Error("no iCCP chunk");
}

// The fixture's only `colr` is nclx; swap it for an embedded ICC profile and fix up sizes and offsets.
function replaceHeicColorWithProfile(heic: Uint8Array, profile: Uint8Array) {
  const view = new DataView(heic.buffer);
  const colr = heic.findIndex((_, index) => view.getUint32(index) === 0x636f6c72) - 4;
  const colrSize = view.getUint32(colr);
  const box = new Uint8Array(12 + profile.length);
  new DataView(box.buffer).setUint32(0, box.length);
  box.set(new TextEncoder().encode("colrprof"), 4);
  box.set(profile, 12);
  const delta = box.length - colrSize;
  const out = new Uint8Array(heic.length + delta);
  out.set(heic.subarray(0, colr));
  out.set(box, colr);
  out.set(heic.subarray(colr + colrSize), colr + box.length);
  const outView = new DataView(out.buffer);
  const find = (type: string) =>
    out.findIndex((_, index) => new TextDecoder().decode(out.subarray(index, index + 4)) === type) -
    4;
  for (const type of ["meta", "iprp", "ipco"]) {
    const offset = find(type);
    outView.setUint32(offset, outView.getUint32(offset) + delta);
  }
  // iloc v0 with 4-byte offsets and lengths, no base offset: one extent per item.
  const iloc = find("iloc");
  for (let item = 0; item < outView.getUint16(iloc + 14); item += 1) {
    const extentOffset = iloc + 16 + item * 14 + 6;
    outView.setUint32(extentOffset, outView.getUint32(extentOffset) + delta);
  }
  return out;
}

describe("prepareImageForAttachment color", () => {
  // P3 green lies outside sRGB, so an sRGB canvas clips it; a P3 canvas would turn sRGB red's
  // stored (255,0,0) into P3 values.
  it.each([
    ["Display P3 PNG", "display-p3", "color(display-p3 0 1 0)", "image/png"],
    ["Display P3 JPEG", "display-p3", "color(display-p3 0 1 0)", "image/jpeg"],
    ["sRGB PNG", "srgb", "#ff0000", "image/png"],
    ["sRGB JPEG", "srgb", "#ff0000", "image/jpeg"],
  ] as const)("keeps a downscaled %s in its own color space", async (_, space, fill, type) => {
    const source = await makeImage(space, fill, type);

    const result = await prepareImageForAttachment(source, 20 * 1024 * 1024);
    if (!result.ok) throw new Error(result.reason);
    expect(result.recompressed).toBe(true);
    expect(result.imageSize).toEqual({ width: 2000, height: 1333 });
    await expectSameColors(result.file, source);
  });

  it("redraws a 16-bit Display P3 PNG at 8 bits per channel and keeps its colors", async () => {
    const readBitDepth = async (png: Blob) => new Uint8Array(await png.arrayBuffer())[24];
    const source = await makeImage("display-p3", "color(display-p3 0 1 0)", "image/png", {
      width: 300,
      height: 400,
      colorType: "float16",
    });
    expect(await readBitDepth(source)).toBe(16);

    const result = await prepareImageForAttachment(source, 20 * 1024 * 1024);
    if (!result.ok) throw new Error(result.reason);
    expect(result.imageSize).toEqual({ width: 300, height: 400 });
    expect(result.file.type).toBe("image/png");
    expect(await readBitDepth(result.file)).toBe(8);
    await expectSameColors(result.file, source);
  });

  it("keeps Display P3 colors when the stash re-encodes a WebP", async () => {
    const source = await makeImage("display-p3", "color(display-p3 0 1 0)", "image/webp");
    const result = await compressImageForStash(
      source,
      (await readFileAsDataUrl(source)).length - 1,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.image.recompressed).toBe(true);
    const stored = dataUrlToFile(result.image.dataUrl, "stash", result.image.mimeType);
    await expectSameColors(stored, source);
  });

  it("keeps Display P3 colors when it converts a P3-tagged HEIC that the browser cannot decode", async () => {
    const fixture = new Uint8Array(await (await fetch(heicUrl)).arrayBuffer());
    const fixtureResult = await prepareImageForAttachment(
      new File([fixture], "photo.heic", { type: "image/heic" }),
      20 * 1024 * 1024,
    );
    if (!fixtureResult.ok) throw new Error(fixtureResult.reason);
    // The fixture declares unspecified primaries, so it decodes as sRGB.
    const decoded = await readPixel(fixtureResult.file, true);

    const nclx = fixture.slice();
    const nclxOffset = nclx.findIndex(
      (_, index) => new DataView(nclx.buffer).getUint32(index) === 0x6e636c78,
    );
    new DataView(nclx.buffer).setUint16(nclxOffset + 4, 12);
    const tagged = [
      nclx,
      replaceHeicColorWithProfile(fixture, await readChromiumDisplayP3Profile()),
    ];
    for (const heic of tagged) {
      const result = await prepareImageForAttachment(
        new File([heic], "photo.heic", { type: "image/heic" }),
        20 * 1024 * 1024,
      );
      if (!result.ok) throw new Error(result.reason);
      expectNear(await readPixel(result.file), decoded);
    }
  });
});
