import JSZip from "jszip";
import { expect, it, vi } from "vite-plus/test";

import {
  ARCHIVE_ENTRY_MAX_BYTES,
  formatArchiveModifiedDate,
  type BinaryWorkerRequest,
  type BinaryWorkerResult,
} from "./binaryPreviewProtocol";

async function startWorker() {
  const worker = new EventTarget();
  let receive = (_result: BinaryWorkerResult) => {};
  vi.stubGlobal(
    "self",
    Object.assign(worker, { postMessage: (result: BinaryWorkerResult) => receive(result) }),
  );
  vi.resetModules();
  await import("./binaryPreview.worker");
  return (input: BinaryWorkerRequest) =>
    new Promise<BinaryWorkerResult>((resolve) => {
      receive = resolve;
      worker.dispatchEvent(new MessageEvent("message", { data: input }));
    });
}

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

    try {
      const request = await startWorker();
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
            code: "archive-entry-too-large",
            message: "archive-entry-too-large",
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
        code: "archive-entry-unavailable",
        message: "archive-entry-unavailable",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it.each([
  { timeZone: "Asia/Tokyo", tarEvening: "11/26/2026", tarNight: "11/25/2026" },
  { timeZone: "America/Chicago", tarEvening: "11/25/2026", tarNight: "11/24/2026" },
  { timeZone: "America/Nuuk", tarEvening: "11/25/2026", tarNight: "11/24/2026" },
])(
  "formats archived ZIP dates and local TAR instants in $timeZone",
  async ({ timeZone, tarEvening, tarNight }) => {
    const zip = new JSZip();
    // JSZip writes the UTC parts of these dates as the entries' DOS wall-clock fields.
    zip.file("evening.txt", "a", { date: new Date(Date.UTC(2026, 10, 25, 20, 0)) });
    zip.file("night.txt", "b", { date: new Date(Date.UTC(2026, 10, 25, 1, 30)) });
    zip.file("dst-midnight.txt", "c", { date: new Date(Date.UTC(2026, 2, 28, 23, 30)) });
    const bytes = await zip.generateAsync({ type: "arraybuffer" });
    const previous = process.env.TZ;
    process.env.TZ = timeZone;
    try {
      const request = await startWorker();
      const result = await request({ type: "open", kind: "archive", name: "times.zip", bytes });
      if (result.type !== "archive") throw new Error("Expected archive");
      expect(result.entries.map(({ modified }) => modified)).toEqual([
        "2026-11-25T20:00:00.000",
        "2026-11-25T01:30:00.000",
        "2026-03-28T23:30:00.000",
      ]);
      expect(
        result.entries.map(({ modified }) => formatArchiveModifiedDate(modified, "en-US")),
      ).toEqual(["11/25/2026", "11/25/2026", "3/28/2026"]);
      expect([
        formatArchiveModifiedDate("2026-11-25T20:00:00.000Z", "en-US"),
        formatArchiveModifiedDate("2026-11-25T01:30:00.000Z", "en-US"),
        formatArchiveModifiedDate(null, "en-US"),
      ]).toEqual([tarEvening, tarNight, "-"]);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
      vi.unstubAllGlobals();
    }
  },
);

it("formats singular and plural byte labels for SQLite BLOB cells", async () => {
  const { default: initSqlJs } = await import("sql.js");
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(
    "CREATE TABLE blobs(empty BLOB, one BLOB, four BLOB); INSERT INTO blobs VALUES (X'', X'FF', X'DEADBEEF');",
  );
  const bytes = db.export().slice().buffer;
  db.close();

  try {
    const request = await startWorker();
    await request({ type: "open", kind: "sqlite", name: "blobs.sqlite", bytes });
    expect(await request({ type: "rows", table: "blobs", page: 0 })).toEqual({
      type: "rows",
      table: "blobs",
      page: 0,
      columns: ["empty", "one", "four"],
      rows: [["[blob: 0 bytes]", "[blob: 1 byte]", "[blob: 4 bytes]"]],
    });
  } finally {
    vi.unstubAllGlobals();
  }
});
