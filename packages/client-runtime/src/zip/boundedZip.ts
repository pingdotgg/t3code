import JSZip from "jszip";
import { checkZipDirectory } from "./zipDirectory.ts";
import { ZipError } from "./zipError.ts";

const CP437_HIGH_BYTES =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒ" +
  "áíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
  "└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// JSZip only calls this for names without the UTF-8 flag or a Unicode path field. Many
// archivers still write UTF-8 there, so CP437 (the ZIP spec's default) is the fallback;
// replacing invalid bytes instead would collapse distinct legacy names into one key.
function decodeFileName(name: string[] | Uint8Array) {
  const raw = Array.isArray(name) ? Uint8Array.from(name, (char) => char.charCodeAt(0)) : name;
  try {
    return utf8.decode(raw);
  } catch {
    return Array.from(raw, (byte) =>
      byte < 128 ? String.fromCharCode(byte) : CP437_HIGH_BYTES[byte - 128],
    ).join("");
  }
}

export const ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
export const ARCHIVE_ENTRY_MAX_BYTES = 10 * 1024 * 1024;
export const ARCHIVE_MAX_ENTRIES = 2048;
export const ARCHIVE_MAX_RATIO = 200;

export async function boundedZip(
  bytes: ArrayBuffer,
  entryLimit = ARCHIVE_MAX_BYTES,
  limits: {
    totalLimit?: number;
    xmlLimit?: number;
    ratioFloor?: number;
    markupLimit?: number;
    password?: string | undefined;
    maxEntries?: number;
    signal?: AbortSignal | undefined;
  } = {},
) {
  if (bytes.byteLength > ARCHIVE_MAX_BYTES) throw new ZipError({ code: "file-too-large" });
  const maxEntries = limits.maxEntries ?? ARCHIVE_MAX_ENTRIES;
  const { encrypted } = checkZipDirectory(bytes, maxEntries);
  if (encrypted) {
    if (limits.password === undefined) throw new ZipError({ code: "password-required" });
    const { readEncryptedZip } = await import("./encryptedZip.ts");
    return readEncryptedZip(bytes, limits.password, {
      entryLimit,
      totalLimit: Math.min(
        limits.totalLimit ?? ARCHIVE_MAX_BYTES,
        Math.max(limits.ratioFloor ?? 0, bytes.byteLength * ARCHIVE_MAX_RATIO),
      ),
      xmlLimit: limits.xmlLimit ?? 8 * 1024 * 1024,
      markupLimit: limits.markupLimit,
      signal: limits.signal,
      decodeFileName,
    });
  }
  const zip = await JSZip.loadAsync(bytes, { decodeFileName });
  const entries = Object.values(zip.files);
  if (entries.length > maxEntries) throw new ZipError({ code: "archive-too-many-entries" });
  const files = new Map<
    string,
    { bytes: Uint8Array<ArrayBuffer>; date: Date; directory: boolean }
  >();
  let total = 0;
  let markup = 0;
  for (const entry of entries) {
    if (entry.name.length > 1024) throw new ZipError({ code: "archive-path-too-long" });
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    const isXmlEntry = entry.name.toLowerCase().endsWith(".xml");
    let length = 0;
    await new Promise<void>((resolve, reject) => {
      const stream = (
        entry as JSZip.JSZipObject & {
          internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array<ArrayBuffer>>;
        }
      ).internalStream("uint8array");
      stream
        .on("data", (chunk) => {
          total += chunk.length;
          length += chunk.length;
          // Word relationship targets can use arbitrary extensions, so count every part.
          if (limits.markupLimit !== undefined)
            for (const byte of chunk) if (byte === 0x3c) markup++;
          if (
            markup > (limits.markupLimit ?? Infinity) ||
            total > (limits.totalLimit ?? ARCHIVE_MAX_BYTES) ||
            total >
              Math.max(limits.ratioFloor ?? 0, Math.max(1, bytes.byteLength) * ARCHIVE_MAX_RATIO) ||
            length > entryLimit ||
            (isXmlEntry && length > (limits.xmlLimit ?? 8 * 1024 * 1024))
          ) {
            stream.pause();
            reject(new ZipError({ code: "archive-expanded-too-large" }));
          } else chunks.push(chunk);
        })
        .on("error", reject)
        .on("end", resolve)
        .resume();
    });
    const content = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.length;
    }
    files.set(entry.name, { bytes: content, date: entry.date, directory: entry.dir });
  }
  return files;
}
