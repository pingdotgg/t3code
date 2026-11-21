// @effect-diagnostics nodeBuiltinImport:off -- The extractor reads from a Node FileHandle.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  BLEND_THUMBNAIL_LIMITS,
  extractBlendThumbnailPng,
  scanBlendThumbnail,
} from "./blendThumbnail.ts";

type Layout = "bhead4" | "small-bhead8" | "large-bhead8";

const ascii = (text: string) => Uint8Array.from(text, (character) => character.charCodeAt(0));

function concat(parts: ReadonlyArray<Uint8Array>) {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function fileHeader(layout: Layout, version = 405) {
  if (layout === "large-bhead8") return ascii("BLENDER17-01v0502");
  return ascii(`BLENDER${layout === "bhead4" ? "_" : "-"}v${String(version).padStart(3, "0")}`);
}

function block(layout: Layout, code: string, data: Uint8Array) {
  const size = layout === "bhead4" ? 20 : layout === "small-bhead8" ? 24 : 32;
  const header = new Uint8Array(size);
  const view = new DataView(header.buffer);
  header.set(ascii(code));
  if (layout === "large-bhead8") {
    view.setBigInt64(16, BigInt(data.length), true);
    view.setBigInt64(24, 1n, true);
  } else {
    view.setInt32(4, data.length, true);
    view.setInt32(size - 4, 1, true);
  }
  return concat([header, data]);
}

/** Each stored row is filled with its bottom-up row index, so a flipped image counts down. */
function thumbnailData(width: number, height: number) {
  const data = new Uint8Array(8 + width * height * 4);
  const view = new DataView(data.buffer);
  view.setInt32(0, width, true);
  view.setInt32(4, height, true);
  for (let row = 0; row < height; row += 1) {
    data.fill(row, 8 + row * width * 4, 8 + (row + 1) * width * 4);
  }
  return data;
}

function blendFile(
  layout: Layout,
  options: { readonly width?: number; readonly height?: number; readonly thumbnail?: boolean } = {},
) {
  const width = options.width ?? 4;
  const height = options.height ?? 3;
  return concat([
    fileHeader(layout),
    block(layout, "REND", new Uint8Array(40)),
    ...(options.thumbnail === false ? [] : [block(layout, "TEST", thumbnailData(width, height))]),
    block(layout, "GLOB", new Uint8Array(64)),
    block(layout, "DNA1", new Uint8Array(16)),
    block(layout, "ENDB", new Uint8Array(0)),
  ]);
}

/** Splits zstd output into frames with a seek table, as Blender writes it. */
function seekableZstd(frames: ReadonlyArray<Uint8Array>) {
  const compressed = frames.map((frame) => NodeZlib.zstdCompressSync(frame));
  const table = new Uint8Array(compressed.length * 8 + 9);
  const view = new DataView(table.buffer);
  compressed.forEach((frame, index) => {
    view.setUint32(index * 8, frame.length, true);
    view.setUint32(index * 8 + 4, frames[index]!.length, true);
  });
  view.setUint32(compressed.length * 8, compressed.length, true);
  view.setUint32(compressed.length * 8 + 5, 0x8f92eab1, true);
  const skippable = new Uint8Array(8);
  new DataView(skippable.buffer).setUint32(0, 0x184d2a5e, true);
  new DataView(skippable.buffer).setUint32(4, table.length, true);
  return concat([...compressed, skippable, table]);
}

function decodePng(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    expect(view.getUint32(offset + 8 + length)).toBe(
      NodeZlib.crc32(png.subarray(offset + 4, offset + 8 + length)),
    );
    if (type === "IHDR") {
      width = new DataView(data.buffer, data.byteOffset).getUint32(0);
      height = new DataView(data.buffer, data.byteOffset).getUint32(4);
      expect([...data.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
    }
    if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  const scanlines = NodeZlib.inflateSync(concat(idat));
  const rows = Array.from({ length: height }, (_, row) => {
    const start = row * (width * 4 + 1);
    expect(scanlines[start]).toBe(0);
    return scanlines[start + 1]!;
  });
  return { width, height, rows };
}

let directory = "";
beforeAll(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-blend-thumbnail-"));
});
afterAll(async () => {
  await NodeFSP.rm(directory, { recursive: true, force: true });
});

async function extract(
  name: string,
  bytes: Uint8Array,
  limits = BLEND_THUMBNAIL_LIMITS,
  signal = new AbortController().signal,
) {
  const filePath = NodePath.join(directory, name);
  await NodeFSP.writeFile(filePath, bytes);
  const handle = await NodeFSP.open(filePath, "r");
  try {
    return await extractBlendThumbnailPng(handle, bytes.length, signal, limits);
  } finally {
    await handle.close();
  }
}

describe("scanBlendThumbnail", () => {
  it.each(["bhead4", "small-bhead8", "large-bhead8"] as const)(
    "reads the thumbnail top-down from %s files",
    (layout) => {
      const scan = scanBlendThumbnail(blendFile(layout));
      expect(scan.status).toBe("found");
      if (scan.status !== "found") return;
      expect([scan.width, scan.height]).toEqual([4, 3]);
      expect([scan.rgba[0], scan.rgba[16], scan.rgba[32]]).toEqual([2, 1, 0]);
    },
  );

  it("asks for more bytes until the thumbnail is complete", () => {
    const bytes = blendFile("large-bhead8");
    for (const length of [0, 11, 16, 17, 60, 100]) {
      expect(scanBlendThumbnail(bytes.subarray(0, length)).status).toBe("incomplete");
    }
  });

  it.each([
    ["files without a thumbnail", blendFile("large-bhead8", { thumbnail: false })],
    ["other formats", ascii("PK\u0003\u0004 not a blend file")],
    ["big-endian files", ascii("BLENDER-V279xxxxxxxxxxxxxxxxxxxxxxxxx")],
    ["files older than 2.50", concat([fileHeader("small-bhead8", 249), new Uint8Array(64)])],
    ["unknown header versions", ascii("BLENDER17-02v0502xxxxxxxxxxxxxxxxxx")],
    ["oversized thumbnails", blendFile("bhead4", { width: 2048, height: 1 })],
  ])("reports %s as absent", (_, bytes) => {
    expect(scanBlendThumbnail(bytes).status).toBe("absent");
  });

  it("rejects a thumbnail whose block length disagrees with its size", () => {
    const bytes = blendFile("bhead4");
    // TEST width sits after the header, the REND block, and the TEST block header.
    new DataView(bytes.buffer).setInt32(12 + 20 + 40 + 20, 5, true);
    expect(scanBlendThumbnail(bytes).status).toBe("absent");
  });
});

describe("extractBlendThumbnailPng", () => {
  it.each([
    ["uncompressed", (bytes: Uint8Array) => bytes],
    ["gzip", (bytes: Uint8Array) => NodeZlib.gzipSync(bytes)],
    ["zstd", (bytes: Uint8Array) => NodeZlib.zstdCompressSync(bytes)],
    [
      "seekable zstd",
      (bytes: Uint8Array) => seekableZstd([bytes.subarray(0, 40), bytes.subarray(40)]),
    ],
  ])("encodes the thumbnail from %s files as PNG", async (name, compress) => {
    const png = await extract(`${name}.blend`, compress(blendFile("large-bhead8")));
    expect(png).not.toBeNull();
    expect(decodePng(png!)).toEqual({ width: 4, height: 3, rows: [2, 1, 0] });
  });

  it("returns null for a blank thumbnail", async () => {
    const bytes = blendFile("large-bhead8");
    // Overwrite the pixels after the header, REND block, TEST block header and size.
    bytes.fill(0, 17 + 32 + 40 + 32 + 8, 17 + 32 + 40 + 32 + 8 + 4 * 3 * 4);
    expect(await extract("blank.blend", bytes)).toBeNull();
  });

  it("returns null when the file has no thumbnail", async () => {
    const bytes = NodeZlib.zstdCompressSync(blendFile("large-bhead8", { thumbnail: false }));
    expect(await extract("empty.blend", bytes)).toBeNull();
  });

  it("returns null for a truncated thumbnail", async () => {
    const bytes = blendFile("small-bhead8");
    expect(await extract("truncated.blend", bytes.subarray(0, bytes.length - 160))).toBeNull();
  });

  it("stops at the scan and input limits", async () => {
    const bytes = blendFile("large-bhead8", { width: 64, height: 64 });
    const limits = { ...BLEND_THUMBNAIL_LIMITS, maxScanBytes: 1024 };
    expect(await extract("scan-limit.blend", NodeZlib.gzipSync(bytes), limits)).toBeNull();
    const inputLimits = { ...BLEND_THUMBNAIL_LIMITS, maxInputBytes: 1024 };
    expect(await extract("input-limit.blend", bytes, inputLimits)).toBeNull();
  });

  it("stops when the request is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      extract("aborted.blend", blendFile("bhead4"), BLEND_THUMBNAIL_LIMITS, controller.signal),
    ).rejects.toThrow();
  });
});
