import { expect, it, vi } from "vite-plus/test";

import {
  ARCHIVE_ENTRY_MAX_BYTES,
  type BinaryWorkerRequest,
  type BinaryWorkerResult,
} from "./binaryPreviewProtocol";

it.each([ARCHIVE_ENTRY_MAX_BYTES, ARCHIVE_ENTRY_MAX_BYTES + 1])(
  "only copies previewable TAR payloads with a %i-byte entry",
  async (size) => {
    const encode = (value: string) => new TextEncoder().encode(value);
    const large = new Uint8Array(size).fill(97);
    const entries = [
      { path: "before.txt", bytes: encode("before") },
      { path: "large.txt", bytes: large },
      { path: "empty.txt", bytes: new Uint8Array() },
      { path: "large-link.txt", bytes: new Uint8Array(), link: "large.txt" },
      { path: "after.txt", bytes: encode("after") },
    ];
    const contents = (entry: (typeof entries)[number]) => (entry.link ? large : entry.bytes);
    const bytes = new Uint8Array(
      entries.reduce(
        (length, entry) => length + 512 + Math.ceil(entry.bytes.length / 512) * 512,
        1024,
      ),
    );
    let offset = 0;
    for (const entry of entries) {
      const write = (position: number, value: string) =>
        bytes.set(encode(value), offset + position);
      write(0, entry.path);
      write(124, entry.bytes.length.toString(8).padStart(11, "0") + "\0");
      write(136, "00000000000\0");
      bytes.fill(32, offset + 148, offset + 156);
      write(156, entry.link ? "1" : "0");
      if (entry.link) write(157, entry.link);
      write(
        148,
        bytes
          .subarray(offset, offset + 512)
          .reduce((sum, byte) => sum + byte, 0)
          .toString(8)
          .padStart(6, "0") + "\0 ",
      );
      bytes.set(entry.bytes, offset + 512);
      offset += 512 + Math.ceil(entry.bytes.length / 512) * 512;
    }

    const worker = new EventTarget();
    let receive = (_result: BinaryWorkerResult) => {};
    vi.stubGlobal(
      "self",
      Object.assign(worker, { postMessage: (result: BinaryWorkerResult) => receive(result) }),
    );
    try {
      vi.resetModules();
      await import("./binaryPreview.worker");
      const request = (input: BinaryWorkerRequest) =>
        new Promise<BinaryWorkerResult>((resolve) => {
          receive = resolve;
          worker.dispatchEvent(new MessageEvent("message", { data: input }));
        });
      using copies = vi.spyOn(Uint8Array.prototype, "slice");
      expect(
        await request({ type: "open", kind: "archive", name: "mixed.tar", bytes: bytes.buffer }),
      ).toEqual({
        type: "archive",
        entries: entries.map((entry) => ({
          path: entry.path,
          size: contents(entry).length,
          directory: false,
          modified: "1970-01-01T00:00:00.000Z",
        })),
      });
      const copiedBytes = copies.mock.results.reduce(
        (total, result) => total + (result.type === "return" ? result.value.byteLength : 0),
        0,
      );
      expect(copiedBytes).toBe(11 + (size <= ARCHIVE_ENTRY_MAX_BYTES ? size : 0));
      for (const entry of entries) {
        const result = await request({ type: "entry", path: entry.path });
        const expected = contents(entry);
        if (expected.length > ARCHIVE_ENTRY_MAX_BYTES) {
          expect(result).toEqual({
            type: "error",
            message: "Entry previews are limited to 10 MB.",
          });
        } else {
          if (result.type !== "entry") throw new Error("Expected entry");
          expect(result.path).toBe(entry.path);
          expect(result.bytes.length).toBe(expected.length);
          expect(result.bytes.every((byte, index) => byte === expected[index])).toBe(true);
        }
      }
      expect(await request({ type: "entry", path: "missing.txt" })).toEqual({
        type: "error",
        message: "This archive entry is unavailable.",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
