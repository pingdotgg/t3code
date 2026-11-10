import JSZip from "jszip";
import { describe, expect, it } from "vite-plus/test";

import { boundedZip, rangedZip } from "./boundedZip.ts";

function source(initial: Uint8Array, options: { etag?: string | null } = {}) {
  const state = { bytes: initial, etag: options.etag === undefined ? 'W/"1"' : options.etag };
  const ranges: string[] = [];
  const fetchRange = async (_url: string, init: { headers: { range: string } }) => {
    ranges.push(init.headers.range);
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(init.headers.range)!.map(Number);
    const body = state.bytes.slice(start, end! + 1);
    return {
      status: 206,
      headers: new Headers({
        "content-range": `bytes ${start}-${end}/${state.bytes.length}`,
        ...(state.etag ? { etag: state.etag } : {}),
      }),
      arrayBuffer: async () => body.buffer,
    };
  };
  return { state, ranges, fetchRange };
}

async function sample() {
  const zip = new JSZip();
  zip.folder("docs");
  // @effect-diagnostics-next-line globalDate:off -- JSZip stores entry times from a JS Date.
  zip.file("docs/café.txt", "unicode name", { date: new Date(Date.UTC(2024, 4, 6, 7, 8, 10)) });
  zip.file("123", "integer-like names sort first, as in JSZip");
  zip.file("stored.bin", new Uint8Array(4096).fill(7), { compression: "STORE" });
  // Enough entries that the central directory starts before the 64 KiB tail read.
  for (let index = 0; index < 1200; index++)
    zip.file(`src/${"nested/".repeat(4)}file-${index}.ts`, `export const value = ${index};\n`);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

function centralRecords(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const offsets: number[] = [];
  let offset = view.getUint32(bytes.length - 6, true);
  while (view.getUint32(offset, true) === 0x02014b50) {
    offsets.push(offset);
    offset +=
      46 +
      view.getUint16(offset + 28, true) +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }
  return { view, offsets };
}

describe("rangedZip", () => {
  it("lists and reads the same entries as the full reader", async () => {
    const bytes = await sample();
    const full = await boundedZip(bytes.slice().buffer);
    const { ranges, fetchRange } = source(bytes);
    const ranged = (await rangedZip("archive.zip", fetchRange))!;

    expect(ranges).toHaveLength(3);
    expect([...ranged.entries].map(([path, entry]) => [path, entry.size, entry.directory])).toEqual(
      [...full].map(([path, entry]) => [path, entry.bytes.length, entry.directory]),
    );
    expect([...ranged.entries.values()].map((entry) => entry.modified)).toEqual(
      [...full.values()].map((entry) => entry.date.getTime()),
    );
    for (const path of [
      "123",
      "docs/café.txt",
      "stored.bin",
      "src/nested/nested/nested/nested/file-1199.ts",
    ])
      expect(await ranged.read(path)).toEqual(full.get(path)!.bytes);
  });

  it("leaves archives it cannot read consistently to the full reader", async () => {
    const plain = await new JSZip().file("a.txt", "a").generateAsync({ type: "uint8array" });
    const patched = (patch: (view: DataView, central: number) => void) => {
      const copy = plain.slice();
      const { view, offsets } = centralRecords(copy);
      patch(view, offsets[0]!);
      return copy;
    };
    expect(await rangedZip("a.zip", source(plain).fetchRange)).not.toBeNull();
    const cases = [
      source(plain, { etag: null }),
      source(patched((view) => view.setUint16(plain.length - 12, 0xffff, true))),
      source(patched((view, central) => view.setUint16(central + 10, 12, true))),
      // "a.txt" becomes "./txt", which JSZip resolves.
      source(patched((view, central) => view.setUint16(central + 46, 0x2f2e, true))),
      source(
        patched((view, central) => view.setUint32(central + 42, plain.length - 22 - 10, true)),
      ),
    ];
    for (const { fetchRange } of cases) expect(await rangedZip("a.zip", fetchRange)).toBeNull();
    const ignored = async () => ({
      status: 200,
      headers: new Headers({ etag: 'W/"1"' }),
      arrayBuffer: async () => plain.slice().buffer,
    });
    expect(await rangedZip("a.zip", ignored)).toBeNull();
  });

  it("keeps one archive revision across range requests", async () => {
    const bytes = await sample();
    const listing = source(bytes);
    const fetchRange: typeof listing.fetchRange = async (url, init) => {
      if (listing.ranges.length === 1) listing.state.etag = 'W/"2"';
      return listing.fetchRange(url, init);
    };
    expect(await rangedZip("archive.zip", fetchRange)).toBeNull();

    const later = source(bytes);
    const ranged = (await rangedZip("archive.zip", later.fetchRange))!;
    later.state.etag = 'W/"2"';
    await expect(ranged.read("123")).rejects.toThrow("This archive changed");
  });

  it("applies the full reader's expansion limits before and after fetching a member", async () => {
    const bytes = await new JSZip()
      .file("zeros.bin", new Uint8Array(2 * 1024 * 1024))
      .file("small.txt", "small")
      .generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const limit = "The expanded archive exceeds the preview size or compression ratio limit.";
    await expect(boundedZip(bytes.slice().buffer, 1024 * 1024)).rejects.toThrow(limit);
    await expect(rangedZip("a.zip", source(bytes).fetchRange, 1024 * 1024)).rejects.toThrow(limit);

    const understated = bytes.slice();
    const { view, offsets } = centralRecords(understated);
    view.setUint32(offsets[0]! + 24, 10, true);
    const ranged = (await rangedZip("a.zip", source(understated).fetchRange, 1024 * 1024))!;
    await expect(ranged.read("zeros.bin")).rejects.toThrow();
    expect(new TextDecoder().decode(await ranged.read("small.txt"))).toBe("small");
  });
});
