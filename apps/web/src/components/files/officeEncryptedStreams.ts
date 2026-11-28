import { PreviewError } from "./previewFailure";

const END_OF_CHAIN = 0xfffffffe;
const MAX_DIRECTORY_BYTES = 1024 * 1024;

function invalid(): never {
  throw new PreviewError({ code: "office-invalid" });
}

export function isCompoundOfficeFile(bytes: ArrayBuffer) {
  if (bytes.byteLength < 8) return false;
  const header = new DataView(bytes);
  return header.getUint32(0) === 0xd0cf11e0 && header.getUint32(4) === 0xa1b11ae1;
}

// Encrypted OOXML uses two root streams in an MS-CFB container.
export function readOfficeEncryptedStreams(bytes: ArrayBuffer) {
  const view = new DataView(bytes);
  if (bytes.byteLength < 512) invalid();
  const version = view.getUint16(26, true);
  const shift = view.getUint16(30, true);
  if (
    view.getUint16(28, true) !== 0xfffe ||
    view.getUint16(32, true) !== 6 ||
    view.getUint32(56, true) !== 4096 ||
    !((version === 3 && shift === 9) || (version === 4 && shift === 12))
  )
    invalid();
  const sectorSize = 2 ** shift;
  const sectorCount = bytes.byteLength / sectorSize - 1;
  if (!Number.isInteger(sectorCount) || sectorCount < 1) invalid();
  function sector(id: number) {
    if (id >= sectorCount) invalid();
    return new Uint8Array(bytes, (id + 1) * sectorSize, sectorSize);
  }

  const fatCount = view.getUint32(44, true);
  const difatCount = view.getUint32(72, true);
  if (fatCount > sectorCount || difatCount > sectorCount) invalid();
  const fat: DataView[] = [];
  const used = new Set<number>();
  function reserve(id: number) {
    if (used.has(id)) invalid();
    used.add(id);
    return sector(id);
  }
  function addFat(id: number) {
    const data = reserve(id);
    fat.push(new DataView(data.buffer, data.byteOffset, sectorSize));
  }
  for (let i = 0; i < Math.min(109, fatCount); i++) addFat(view.getUint32(76 + i * 4, true));
  let difat = view.getUint32(68, true);
  for (let i = 0; i < difatCount; i++) {
    const data = reserve(difat);
    const table = new DataView(data.buffer, data.byteOffset, sectorSize);
    for (let offset = 0; offset < sectorSize - 4 && fat.length < fatCount; offset += 4)
      addFat(table.getUint32(offset, true));
    difat = table.getUint32(sectorSize - 4, true);
  }
  if (fat.length !== fatCount) invalid();

  function readChain(start: number, maxBytes: number, size?: number) {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    for (let id = start; id !== END_OF_CHAIN;) {
      if (chunks.length >= Math.ceil(maxBytes / sectorSize)) invalid();
      chunks.push(reserve(id));
      const fatOffset = id * 4;
      const table = fat[Math.floor(fatOffset / sectorSize)];
      if (!table) invalid();
      id = table.getUint32(fatOffset % sectorSize, true);
    }
    const capacity = chunks.length * sectorSize;
    if (size !== undefined && chunks.length !== Math.ceil(size / sectorSize)) invalid();
    const data = new Uint8Array(capacity);
    chunks.forEach((chunk, index) => data.set(chunk, index * sectorSize));
    return data.subarray(0, size ?? capacity);
  }

  const directory = readChain(view.getUint32(48, true), MAX_DIRECTORY_BYTES);
  const entries = new DataView(directory.buffer);
  const decoder = new TextDecoder("utf-16le");
  function entryAt(index: number) {
    const offset = index * 128;
    if (offset + 128 > directory.length) invalid();
    return {
      offset,
      type: entries.getUint8(offset + 66),
      start: entries.getUint32(offset + 116, true),
      size: Number(entries.getBigUint64(offset + 120, true)),
    };
  }
  const root = entryAt(0);
  if (root.type !== 5) invalid();
  const pending = [entries.getUint32(76, true)];
  const seen = new Set<number>();
  const streams = new Map<string, ReturnType<typeof entryAt>>();
  while (pending.length > 0) {
    const index = pending.pop()!;
    if (index === 0xffffffff) continue;
    if (seen.has(index)) invalid();
    seen.add(index);
    const entry = entryAt(index);
    const length = entries.getUint16(entry.offset + 64, true);
    if (length < 2 || length > 64 || length % 2 !== 0) invalid();
    const name = decoder.decode(directory.subarray(entry.offset, entry.offset + length - 2));
    if (entry.type === 2 && (name === "EncryptionInfo" || name === "EncryptedPackage")) {
      if (streams.has(name)) invalid();
      streams.set(name, entry);
    }
    pending.push(
      entries.getUint32(entry.offset + 68, true),
      entries.getUint32(entry.offset + 72, true),
    );
  }

  const info = streams.get("EncryptionInfo");
  const pkg = streams.get("EncryptedPackage");
  if (!info || !pkg) throw new PreviewError({ code: "office-not-open-xml" });
  if (info.size < 8 || info.size > 64 * 1024 || pkg.size < 24 || pkg.size > bytes.byteLength)
    invalid();
  const miniUsed = new Set<number>();
  let miniStream: Uint8Array | undefined;
  let miniFat: DataView | undefined;
  function readStream(entry: { start: number; size: number }) {
    if (entry.size >= 4096) return readChain(entry.start, entry.size, entry.size);
    miniStream ??= readChain(root.start, Math.min(root.size, bytes.byteLength), root.size);
    miniFat ??= new DataView(
      readChain(view.getUint32(60, true), bytes.byteLength, view.getUint32(64, true) * sectorSize)
        .buffer,
    );
    const result = new Uint8Array(entry.size);
    let id = entry.start;
    for (let offset = 0; offset < entry.size; offset += 64) {
      if (miniUsed.has(id) || id * 64 + 64 > miniStream.length || id * 4 + 4 > miniFat.byteLength)
        invalid();
      miniUsed.add(id);
      result.set(miniStream.subarray(id * 64, id * 64 + Math.min(64, entry.size - offset)), offset);
      id = miniFat.getUint32(id * 4, true);
    }
    if (id !== END_OF_CHAIN) invalid();
    return result;
  }
  return { info: readStream(info), package: readStream(pkg) };
}
