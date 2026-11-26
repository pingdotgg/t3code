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
});
