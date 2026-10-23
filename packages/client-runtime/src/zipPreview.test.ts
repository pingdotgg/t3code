import * as NodeZlib from "node:zlib";
import { decodeFilePreviewText } from "@t3tools/shared/filePreview";
import JSZip from "jszip";
import { describe, expect, it } from "vite-plus/test";

import { loadZipArchive, readZipArchiveStream } from "./zipPreview.ts";

const signal = () => new AbortController().signal;
const archive = (zip: JSZip) => zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });

describe("ZIP byte core", () => {
  it("reads an archive from a byte view with an offset", async () => {
    const zip = await archive(new JSZip().file("src/app.ts", "export const answer = 42;"));
    const padded = new Uint8Array(zip.length + 16);
    padded.set(zip, 8);
    const loaded = await loadZipArchive(padded.subarray(8, 8 + zip.length), signal());
    const entry = loaded.entries.find((entry) => entry.path === "src/app.ts")!;
    expect(new TextDecoder().decode(await loaded.readFile(entry, signal()))).toBe(
      "export const answer = 42;",
    );
    expect(loaded.fileCount).toBe(1);
  });

  it.each([
    [[], false],
    [["a.png", "b.jpg"], true],
    [["a.png", "readme.md"], false],
  ] as const)(
    "classifies image-only archives from their visible files: %j",
    async (names, expected) => {
      const zip = new JSZip();
      for (const name of names) zip.file(name, "data");
      zip.file("__MACOSX/._a", "metadata", { createFolders: false });
      const loaded = await loadZipArchive(await archive(zip), signal());
      expect(loaded.imagesOnly).toBe(expected);
      expect(loaded.hiddenCount).toBe(1);
      expect(loaded.fileCount).toBe(names.length);
    },
  );

  it("checks CRC when a text prefix is the complete file", async () => {
    const bytes = await archive(new JSZip().file("short.log", "server ready"));
    const loaded = await loadZipArchive(bytes, signal());
    const prefix = await loaded.readTextPrefix(loaded.entries[0]!, signal());
    expect(decodeFilePreviewText(prefix.bytes, prefix.truncated)).toEqual({
      text: "server ready",
      truncated: false,
    });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 0; offset + 46 <= bytes.length; offset++) {
      if (view.getUint32(offset, true) === 0x02014b50) view.setUint32(offset + 16, 1, true);
    }
    const corrupt = await loadZipArchive(bytes, signal());
    await expect(corrupt.readTextPrefix(corrupt.entries[0]!, signal())).rejects.toThrow(/corrupt/);
  });

  it("rejects save requests above the separate output limit before extraction", async () => {
    const bytes = await archive(new JSZip().file("large.log", "data"));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 0; offset + 46 <= bytes.length; offset++) {
      if (view.getUint32(offset, true) === 0x02014b50)
        view.setUint32(offset + 24, 64 * 1024 * 1024 + 1, true);
    }
    const loaded = await loadZipArchive(bytes, signal());
    await expect(loaded.readFileForSave(loaded.entries[0]!, signal())).rejects.toMatchObject({
      reason: "file-limit",
    });
  });

  it("stops full saves at the actual byte limit when the ZIP understates its size", async () => {
    const template = await archive(new JSZip().file("large.log", "data"));
    const templateView = new DataView(template.buffer, template.byteOffset, template.byteLength);
    const start = 30 + templateView.getUint16(26, true) + templateView.getUint16(28, true);
    const oldDirectory = templateView.getUint32(template.length - 6, true);
    const compressed = NodeZlib.deflateRawSync(new Uint8Array(65 * 1024 * 1024), { level: 1 });
    const directory = start + compressed.length;
    const bytes = new Uint8Array(directory + template.length - oldDirectory);
    bytes.set(template.subarray(0, start));
    bytes.set(compressed, start);
    bytes.set(template.subarray(oldDirectory), directory);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(18, compressed.length, true);
    view.setUint32(22, 1, true);
    view.setUint32(directory + 20, compressed.length, true);
    view.setUint32(directory + 24, 1, true);
    view.setUint32(bytes.length - 6, directory, true);
    const loaded = await loadZipArchive(bytes, signal());
    await expect(loaded.readFileForSave(loaded.entries[0]!, signal())).rejects.toMatchObject({
      reason: "file-limit",
    });
  });

  it.each([
    { bytes: new Uint8Array(), reason: "invalid" },
    { bytes: new Uint8Array(32 * 1024 * 1024 + 1), reason: "archive-limit" },
  ])("reports a typed $reason failure", async ({ bytes, reason }) => {
    await expect(loadZipArchive(bytes, signal())).rejects.toMatchObject({ reason });
  });

  it("aborts an active byte download and releases its stream", async () => {
    let cancelled = false;
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array([1, 2]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const received: number[] = [];
    const reading = readZipArchiveStream(body, controller.signal, (bytes) => {
      received.push(bytes);
      controller.abort();
    });
    await expect(reading).rejects.toThrow(/abort/i);
    expect(received).toEqual([2]);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });
});
