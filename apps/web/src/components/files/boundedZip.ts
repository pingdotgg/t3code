import JSZip from "jszip";

import {
  ARCHIVE_MAX_ENTRIES,
  ARCHIVE_MAX_RATIO,
  BINARY_PREVIEW_MAX_BYTES,
} from "./binaryPreviewProtocol";

export async function boundedZip(
  bytes: ArrayBuffer,
  entryLimit = BINARY_PREVIEW_MAX_BYTES,
  limits: {
    totalLimit?: number;
    xmlLimit?: number;
    ratioFloor?: number;
    markupLimit?: number;
  } = {},
) {
  if (bytes.byteLength > BINARY_PREVIEW_MAX_BYTES)
    throw new Error("Preview limited to files under 50 MB.");
  // Reject oversized directories before JSZip allocates objects for their entries.
  const view = new DataView(bytes);
  let directoryEnd = -1;
  let directorySize = 0;
  for (
    let offset = bytes.byteLength - 22;
    offset >= Math.max(0, bytes.byteLength - 65557);
    offset--
  ) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue;
    if (offset + 22 + view.getUint16(offset + 20, true) !== bytes.byteLength)
      throw new Error("This is not a readable ZIP archive.");
    let count = view.getUint16(offset + 10, true);
    directorySize = view.getUint32(offset + 12, true);
    let directoryOffset = view.getUint32(offset + 16, true);
    directoryEnd = offset;
    if (
      [4, 6, 8, 10].some((field) => view.getUint16(offset + field, true) === 0xffff) ||
      directorySize === 0xffffffff ||
      directoryOffset === 0xffffffff
    ) {
      const locator = offset - 20;
      const record = locator - 56;
      if (
        record < 0 ||
        view.getUint32(locator, true) !== 0x07064b50 ||
        view.getUint32(record, true) !== 0x06064b50 ||
        view.getBigUint64(record + 4, true) !== 44n ||
        view.getUint32(record + 16, true) !== 0 ||
        view.getUint32(record + 20, true) !== 0 ||
        view.getUint32(locator + 4, true) !== 0 ||
        view.getUint32(locator + 16, true) !== 1 ||
        view.getBigUint64(locator + 8, true) !== BigInt(record)
      )
        throw new Error("Unsupported ZIP64 directory.");
      const records = view.getBigUint64(record + 32, true);
      const size = view.getBigUint64(record + 40, true);
      const start = view.getBigUint64(record + 48, true);
      if (
        records > BigInt(ARCHIVE_MAX_ENTRIES) ||
        size > BigInt(record) ||
        start > BigInt(record) ||
        view.getBigUint64(locator + 8, true) !== start + size ||
        view.getBigUint64(record + 24, true) !== records
      )
        throw new Error("This ZIP64 directory is too large or damaged.");
      count = Number(records);
      directorySize = Number(size);
      directoryOffset = Number(start);
      directoryEnd = record;
    }
    if (count > ARCHIVE_MAX_ENTRIES)
      throw new Error("This archive contains more than 2,048 entries.");
    if (directoryOffset > directoryEnd - directorySize)
      throw new Error("This ZIP directory is damaged.");
    break;
  }
  if (directoryEnd < 0 || directorySize > directoryEnd)
    throw new Error("This is not a readable ZIP archive.");
  let records = 0;
  for (let offset = directoryEnd - directorySize; offset < directoryEnd;) {
    if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== 0x02014b50)
      throw new Error("This ZIP directory is damaged.");
    if (++records > ARCHIVE_MAX_ENTRIES)
      throw new Error("This archive contains more than 2,048 entries.");
    const nameLength = view.getUint16(offset + 28, true);
    if (nameLength > 1024) throw new Error("An archive path is too long to preview.");
    offset +=
      46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    if (offset > directoryEnd) throw new Error("This ZIP directory is damaged.");
  }
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
            total > (limits.totalLimit ?? BINARY_PREVIEW_MAX_BYTES) ||
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
