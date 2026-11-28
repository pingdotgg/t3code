// Oracle's UEK kernels refuse to exec an ELF whose last PT_NOTE is larger than 4 MiB on disk
// (MAX_FILE_NOTE_SIZE in UEK's fs/binfmt_elf.c, https://github.com/oracle/linux-uek/issues/46).
// A Node SEA keeps its bundle in a NODE_SEA_BLOB note, so t3's note segment is about 22 MiB.
// Node finds that blob in memory through p_memsz, so p_filesz can stop at the small notes before it.
export const UEK_MAX_NOTE_FILE_SIZE = 4 * 1024 * 1024;

const PT_NOTE = 4;
const NOTE_HEADER_SIZE = 12;

export interface TrimmedElfNote {
  readonly index: number;
  readonly fileSize: bigint;
  readonly trimmedFileSize: bigint;
}

/** Shrinks each oversized PT_NOTE's p_filesz to the whole notes within 4 MiB, in place. */
export function trimElfNotesForUek(bytes: Uint8Array): Array<TrimmedElfNote> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 64 ||
    view.getUint32(0, false) !== 0x7f454c46 ||
    bytes[4] !== 2 ||
    bytes[5] !== 1
  ) {
    throw new Error("Expected a little-endian ELF64 executable.");
  }
  const tableOffset = Number(view.getBigUint64(32, true));
  const entrySize = view.getUint16(54, true);
  const count = view.getUint16(56, true);
  if (
    !Number.isSafeInteger(tableOffset) ||
    entrySize < 56 ||
    tableOffset + entrySize * count > bytes.length
  ) {
    throw new Error("Invalid ELF program header table.");
  }
  const trimmed: Array<TrimmedElfNote> = [];
  for (let index = 0; index < count; index++) {
    const header = tableOffset + index * entrySize;
    if (view.getUint32(header, true) !== PT_NOTE) continue;
    const fileSize = view.getBigUint64(header + 32, true);
    if (fileSize <= BigInt(UEK_MAX_NOTE_FILE_SIZE)) continue;
    const offset = Number(view.getBigUint64(header + 8, true));
    if (!Number.isSafeInteger(offset) || BigInt(offset) + fileSize > BigInt(bytes.length)) {
      throw new Error(`PT_NOTE ${index} extends past the end of the file.`);
    }
    // Notes are 4-byte aligned unless the segment says 8 (as GNU property notes do).
    const align = view.getBigUint64(header + 48, true) === 8n ? 8 : 4;
    const alignUp = (value: number) => Math.ceil(value / align) * align;
    let kept = 0;
    while (kept + NOTE_HEADER_SIZE <= UEK_MAX_NOTE_FILE_SIZE) {
      const nameSize = view.getUint32(offset + kept, true);
      const descSize = view.getUint32(offset + kept + 4, true);
      const end = alignUp(alignUp(kept + NOTE_HEADER_SIZE + nameSize) + descSize);
      if (end > UEK_MAX_NOTE_FILE_SIZE) break;
      kept = end;
    }
    if (kept === 0) {
      throw new Error(`PT_NOTE ${index} starts with a note larger than 4 MiB.`);
    }
    view.setBigUint64(header + 32, BigInt(kept), true);
    trimmed.push({ index, fileSize, trimmedFileSize: BigInt(kept) });
  }
  return trimmed;
}
