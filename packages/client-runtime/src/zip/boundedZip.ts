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

const ARCHIVE_CHANGED = "This archive changed or is no longer available. Close it and try again.";

/**
 * Lists a ZIP from its end record and central directory, read through validated byte ranges, and
 * fetches each member when it is read. Resolves `null` when the source cannot serve consistent
 * ranges or the archive needs the full reader (ZIP64, rewritten names, unsupported entries).
 */
export async function rangedZip(
  url: string,
  fetchRange: (
    url: string,
    init: { headers: { range: string }; signal?: AbortSignal },
  ) => Promise<{
    status: number;
    headers: { get(name: string): string | null };
    arrayBuffer(): Promise<ArrayBuffer>;
  }>,
  entryLimit = ARCHIVE_MAX_BYTES,
  signal?: AbortSignal,
) {
  let size = -1;
  let revision: string | null = null;
  const range = async (start: number, end: number) => {
    const response = await fetchRange(url, {
      headers: { range: `bytes=${start}-${end}` },
      ...(signal ? { signal } : {}),
    });
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
    const etag = response.headers.get("etag");
    if (
      response.status !== 206 ||
      !match ||
      !etag ||
      Number(match[1]) !== start ||
      Number(match[2]) !== end ||
      (size >= 0 && (Number(match[3]) !== size || etag !== revision))
    )
      return null;
    size = Number(match[3]);
    revision = etag;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length === end - start + 1 ? bytes : null;
  };
  if (!(await range(0, 0)) || size < 22 || size > ARCHIVE_MAX_BYTES) return null;
  const tailStart = Math.max(0, size - 65557);
  const tail = await range(tailStart, size - 1);
  if (!tail) return null;
  let view = new DataView(tail.buffer);
  let end = tail.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0 || end + 22 + view.getUint16(end + 20, true) !== tail.length) return null;
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryStart = view.getUint32(end + 16, true);
  if (
    view.getUint32(end + 4, true) !== 0 ||
    view.getUint16(end + 8, true) !== count ||
    count > ARCHIVE_MAX_ENTRIES ||
    directoryStart + directorySize !== tailStart + end
  )
    return null;
  const head =
    directoryStart < tailStart ? await range(directoryStart, tailStart - 1) : new Uint8Array();
  if (!head) return null;
  const directory = new Uint8Array(directorySize);
  directory.set(head);
  directory.set(tail.subarray(Math.max(0, directoryStart - tailStart), end), head.length);
  view = new DataView(directory.buffer);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  // Keyed like JSZip's files object, so order and duplicate names match the full reader.
  const files: Record<
    string,
    { size: number; modified: number; directory: boolean; central: Uint8Array; local: number }
  > = Object.create(null);
  let offset = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > directory.length || view.getUint32(offset, true) !== 0x02014b50) return null;
    const method = view.getUint16(offset + 10, true);
    const dosTime = view.getUint32(offset + 12, true);
    const compressed = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraEnd = offset + 46 + nameLength + view.getUint16(offset + 30, true);
    const external = view.getUint32(offset + 38, true);
    const local = view.getUint32(offset + 42, true);
    const next = extraEnd + view.getUint16(offset + 32, true);
    if (next > directory.length) return null;
    const flags = view.getUint16(offset + 8, true);
    // Without the UTF-8 flag, JSZip may take the name from an Info-ZIP Unicode path field.
    for (let extra = offset + 46 + nameLength; extra + 4 <= extraEnd;) {
      if (!(flags & 0x0800) && view.getUint16(extra, true) === 0x7075) return null;
      extra += 4 + view.getUint16(extra + 2, true);
    }
    let name: string;
    try {
      name = decoder.decode(directory.subarray(offset + 46, offset + 46 + nameLength));
    } catch {
      return null;
    }
    // JSZip resolves "." and ".." segments; leave those names to it.
    if (
      flags & 1 ||
      (method !== 0 && method !== 8) ||
      [compressed, view.getUint32(offset + 24, true), local].includes(0xffffffff) ||
      view.getUint16(offset + 34, true) !== 0 ||
      nameLength > 1024 ||
      local + 30 + compressed > directoryStart ||
      name
        .split("/")
        .some(
          (part, at, parts) =>
            part === "." || part === ".." || (part === "" && at !== 0 && at !== parts.length - 1),
        )
    )
      return null;
    const isDirectory =
      (external & 0x10) !== 0 ||
      (view.getUint8(offset + 5) === 3 && ((external >>> 16) & 0x4000) !== 0) ||
      name.endsWith("/");
    if (isDirectory && !name.endsWith("/")) name += "/";
    files[name] = {
      size: view.getUint32(offset + 24, true),
      modified: Date.UTC(
        ((dosTime >>> 25) & 0x7f) + 1980,
        ((dosTime >>> 21) & 0x0f) - 1,
        (dosTime >>> 16) & 0x1f,
        (dosTime >>> 11) & 0x1f,
        (dosTime >>> 5) & 0x3f,
        (dosTime & 0x1f) << 1,
      ),
      directory: isDirectory,
      central: directory.slice(offset, next),
      local,
    };
    offset = next;
  }
  if (offset !== directory.length) return null;
  let total = 0;
  for (const [name, file] of Object.entries(files)) {
    total += file.size;
    if (
      file.size > entryLimit ||
      total > ARCHIVE_MAX_BYTES ||
      total > size * ARCHIVE_MAX_RATIO ||
      (name.endsWith(".xml") && file.size > 8 * 1024 * 1024)
    )
      throw new Error("The expanded archive exceeds the preview size or compression ratio limit.");
  }
  const archiveSize = size;
  return {
    size: archiveSize,
    entries: new Map(
      Object.entries(files).map(([path, file]) => [
        path,
        { size: file.size, modified: file.modified, directory: file.directory },
      ]),
    ),
    async read(path: string) {
      const entry = files[path];
      if (!entry) throw new Error("This archive entry is unavailable.");
      const compressed = new DataView(entry.central.buffer).getUint32(20, true);
      const fetchLocal = (length: number) =>
        range(entry.local, Math.min(directoryStart, entry.local + length) - 1);
      let local = await fetchLocal(30 + entry.central.length + compressed);
      if (!local) throw new Error(ARCHIVE_CHANGED);
      const localView = new DataView(local.buffer);
      const length =
        30 + localView.getUint16(26, true) + localView.getUint16(28, true) + compressed;
      if (localView.getUint32(0, true) !== 0x04034b50 || entry.local + length > directoryStart)
        throw new Error("This ZIP directory is damaged.");
      if (length > local.length) local = await fetchLocal(length);
      if (!local) throw new Error(ARCHIVE_CHANGED);
      // A one-member archive lets the bounded reader inflate it under the same limits.
      const single = new Uint8Array(length + entry.central.length + 22);
      single.set(local.subarray(0, length));
      single.set(entry.central, length);
      const record = new DataView(single.buffer, length);
      record.setUint32(42, 0, true);
      record.setUint32(entry.central.length, 0x06054b50, true);
      record.setUint16(entry.central.length + 8, 1, true);
      record.setUint16(entry.central.length + 10, 1, true);
      record.setUint32(entry.central.length + 12, entry.central.length, true);
      record.setUint32(entry.central.length + 16, length, true);
      const [file] = (
        await boundedZip(single.buffer, entryLimit, { ratioFloor: archiveSize * ARCHIVE_MAX_RATIO })
      ).values();
      if (!file || file.bytes.length !== entry.size)
        throw new Error("This ZIP directory is damaged.");
      return file.bytes;
    },
  };
}
