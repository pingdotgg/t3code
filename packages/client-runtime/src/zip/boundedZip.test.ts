import * as NodeZlib from "node:zlib";
import * as DateTime from "effect/DateTime";
import JSZip from "jszip";
import { describe, expect, it } from "vite-plus/test";
import { boundedZip } from "./boundedZip.ts";

// Writes each name as raw bytes with no UTF-8 flag, as legacy and macOS archivers do.
async function zipWithRawNames(entries: ReadonlyArray<readonly [number[], string]>) {
  const placeholders = entries.map(([raw], index) => String(index).padStart(raw.length, "_"));
  const bytes = new Uint8Array(
    await entries
      .reduce((zip, [, content], index) => zip.file(placeholders[index]!, content), new JSZip())
      .generateAsync({ type: "arraybuffer", compression: "STORE" }),
  );
  const text = new TextDecoder("latin1").decode(bytes);
  entries.forEach(([raw], index) => {
    for (const match of text.matchAll(new RegExp(placeholders[index]!, "g")))
      bytes.set(raw, match.index);
  });
  return bytes.buffer;
}

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

describe("boundedZip", () => {
  it("decodes unflagged names as UTF-8, else CP437, without merging entries", async () => {
    const files = await boundedZip(
      await zipWithRawNames([
        [[...ascii("caf"), 0x82, ...ascii(".txt")], "CP437 e-acute"],
        [[...ascii("caf"), 0x8a, ...ascii(".txt")], "CP437 e-grave"],
        [[...ascii("na"), 0xc3, 0xaf, ...ascii("ve.txt")], "UTF-8"],
        [[0xef, 0xbb, 0xbf, ...ascii("a.txt")], "UTF-8 with BOM"],
        [ascii("a.txt"), "ASCII"],
      ]),
    );
    expect([...files].map(([name, file]) => [name, new TextDecoder().decode(file.bytes)])).toEqual([
      ["café.txt", "CP437 e-acute"],
      ["cafè.txt", "CP437 e-grave"],
      ["naïve.txt", "UTF-8"],
      ["\uFEFFa.txt", "UTF-8 with BOM"],
      ["a.txt", "ASCII"],
    ]);
  });

  it("enforces xmlLimit case-insensitively on unencrypted and encrypted ZIP entries", async () => {
    const payload = "x".repeat(200);
    const bytes = await new JSZip()
      .file("word/document.XML", payload)
      .generateAsync({ type: "arraybuffer", compression: "STORE" });
    await expect(boundedZip(bytes, 1000, { xmlLimit: 100 })).rejects.toMatchObject({
      code: "archive-expanded-too-large",
    });

    const { Uint8ArrayWriter, TextReader, ZipWriter } =
      await import("@zip.js/zip.js/index-native.js");
    const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
    await writer.add("word/document.XML", new TextReader(payload), { password: "open me" });
    const encryptedBytes = (await writer.close()).buffer;
    await expect(
      boundedZip(encryptedBytes, 1000, { password: "open me", xmlLimit: 100 }),
    ).rejects.toMatchObject({
      code: "archive-expanded-too-large",
    });
  });
});

it.each([false, true])("opens a password-protected ZIP (ZipCrypto: %s)", async (zipCrypto) => {
  const { Uint8ArrayWriter, TextReader, ZipWriter } =
    await import("@zip.js/zip.js/index-native.js");
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add("public.txt", new TextReader("Public"), {
    lastModDate: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
    rawLastModDate: (44 << 25) | (12 << 21) | (3 << 16) | (14 << 11) | (15 << 5) | 8,
  });
  await writer.add("secret.txt", new TextReader("Unlocked ZIP".repeat(30)), {
    password: "open me",
    zipCrypto,
  });
  const bytes = (await writer.close()).buffer;
  await expect(boundedZip(bytes)).rejects.toMatchObject({ code: "password-required" });
  await expect(boundedZip(bytes, undefined, { password: "wrong" })).rejects.toMatchObject({
    code: "password-incorrect",
  });
  const files = await boundedZip(bytes, undefined, { password: "open me" });
  expect(new TextDecoder().decode(files.get("public.txt")?.bytes)).toBe("Public");
  expect(files.get("public.txt")?.date.toISOString()).toBe("2024-12-03T14:15:16.000Z");
  expect(new TextDecoder().decode(files.get("secret.txt")?.bytes)).toBe("Unlocked ZIP".repeat(30));
  await expect(boundedZip(bytes, 50, { password: "open me" })).rejects.toMatchObject({
    code: "archive-expanded-too-large",
  });
});

it("rejects an encrypted ZIP whose Unicode path field exceeds the filename limit", async () => {
  const { Uint8ArrayWriter, TextReader, ZipWriter } =
    await import("@zip.js/zip.js/index-native.js");
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
    useUnicodeFileNames: false,
  });
  const fallback = "name.txt";
  const name = new TextEncoder().encode("a".repeat(1025));
  const unicodePath = new Uint8Array(5 + name.length);
  unicodePath[0] = 1;
  new DataView(unicodePath.buffer).setUint32(1, NodeZlib.crc32(fallback), true);
  unicodePath.set(name, 5);
  await writer.add(fallback, new TextReader("Locked"), {
    password: "open me",
    extraField: new Map([[0x7075, unicodePath]]),
  });
  const bytes = (await writer.close()).buffer;
  await expect(boundedZip(bytes, undefined, { password: "open me" })).rejects.toMatchObject({
    code: "archive-path-too-long",
  });
});
