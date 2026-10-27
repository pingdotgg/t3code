import JSZip from "jszip";
import { checkZipDirectory } from "./zipDirectory.ts";

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
  } = {},
) {
  if (bytes.byteLength > ARCHIVE_MAX_BYTES)
    throw new Error("Preview limited to files under 50 MB.");
  checkZipDirectory(bytes, ARCHIVE_MAX_ENTRIES);
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files);
  if (entries.length > ARCHIVE_MAX_ENTRIES)
    throw new Error("This archive contains more than 2,048 entries.");
  const files = new Map<
    string,
    { bytes: Uint8Array<ArrayBuffer>; date: Date; directory: boolean }
  >();
  let total = 0;
  let markup = 0;
  for (const entry of entries) {
    if (entry.name.length > 1024) throw new Error("An archive path is too long to preview.");
    const chunks: Uint8Array<ArrayBuffer>[] = [];
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
            (entry.name.endsWith(".xml") && length > (limits.xmlLimit ?? 8 * 1024 * 1024))
          ) {
            stream.pause();
            reject(
              new Error(
                "The expanded archive exceeds the preview size or compression ratio limit.",
              ),
            );
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
