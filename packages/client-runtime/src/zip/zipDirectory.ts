import { msg } from "gt-i18n";
import { translatableError } from "../errors/translatable.ts";

export function checkZipDirectory(bytes: ArrayBuffer, entryLimit = 2048) {
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
      throw translatableError(msg("This is not a readable ZIP archive."));
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
      // JSZip uses the last locator, including signatures inside the archive comment.
      for (let candidate = bytes.byteLength - 4; candidate > locator; candidate--)
        if (view.getUint32(candidate, true) === 0x07064b50)
          throw translatableError(msg("Unsupported ZIP64 directory."));
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
        throw translatableError(msg("Unsupported ZIP64 directory."));
      const records = view.getBigUint64(record + 32, true);
      const size = view.getBigUint64(record + 40, true);
      const start = view.getBigUint64(record + 48, true);
      if (
        records > BigInt(entryLimit) ||
        size > BigInt(record) ||
        start > BigInt(record) ||
        view.getBigUint64(locator + 8, true) !== start + size ||
        view.getBigUint64(record + 24, true) !== records
      )
        throw translatableError(msg("This ZIP64 directory is too large or damaged."));
      count = Number(records);
      directorySize = Number(size);
      directoryOffset = Number(start);
      directoryEnd = record;
    }
    if (count > entryLimit)
      throw translatableError(msg("This archive contains more than 2,048 entries."));
    if (directoryOffset > directoryEnd - directorySize)
      throw translatableError(msg("This ZIP directory is damaged."));
    break;
  }
  if (directoryEnd < 0 || directorySize > directoryEnd)
    throw translatableError(msg("This is not a readable ZIP archive."));
  let records = 0;
  for (let offset = directoryEnd - directorySize; offset < directoryEnd;) {
    if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== 0x02014b50)
      throw translatableError(msg("This ZIP directory is damaged."));
    if (++records > entryLimit)
      throw translatableError(msg("This archive contains more than 2,048 entries."));
    const nameLength = view.getUint16(offset + 28, true);
    if (nameLength > 1024) throw translatableError(msg("An archive path is too long to preview."));
    offset +=
      46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    if (offset > directoryEnd) throw translatableError(msg("This ZIP directory is damaged."));
  }
}
