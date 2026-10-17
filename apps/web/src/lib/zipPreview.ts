import { hostPreviewMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import {
  IMAGE_DIMENSIONS_HEADER_BYTES,
  readImageDimensions,
} from "@t3tools/shared/imageDimensions";
import JSZip from "jszip";
import crc32 from "jszip/lib/crc32.js";

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 2000;
const MAX_FOLDERS = 2000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_IMAGE_EDGE = 8192;
const ARCHIVE_LIMIT_ERROR = "ZIP preview supports archives up to 32 MiB.";
const ENTRY_LIMIT_ERROR = "ZIP preview supports up to 2,000 files and 2,000 folders.";
const INVALID_ARCHIVE_ERROR =
  "Could not read this ZIP. The archive is corrupt or is not a valid ZIP file.";

export interface ZipPreviewEntry {
  readonly path: string;
  readonly name: string;
  readonly isDirectory: boolean;
  readonly sizeBytes: number;
  readonly mimeType: string | null;
}

type ZipFile = JSZip.JSZipObject & {
  readonly _data: { readonly uncompressedSize: number };
  internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array<ArrayBuffer>>;
};

function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function checkArchiveDirectory(bytes: ArrayBuffer) {
  const view = new DataView(bytes);
  let end = bytes.byteLength - 4;
  const start = Math.max(0, bytes.byteLength - 22 - 65535);
  for (; end >= start; end--) {
    if (view.getUint32(end, true) === 0x06054b50) break;
  }
  if (
    end < start ||
    end + 22 > bytes.byteLength ||
    end + 22 + view.getUint16(end + 20, true) !== bytes.byteLength
  ) {
    throw new Error(INVALID_ARCHIVE_ERROR);
  }
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) === 0xffff ||
    view.getUint16(end + 6, true) === 0xffff ||
    view.getUint16(end + 8, true) === 0xffff ||
    count === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    throw new Error("ZIP64 archives are not supported in ZIP preview.");
  }
  if (
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0 ||
    view.getUint16(end + 8, true) !== count
  ) {
    throw new Error("Multi-part ZIP archives are not supported in ZIP preview.");
  }
  if (count > MAX_FILES + MAX_FOLDERS) throw new Error(ENTRY_LIMIT_ERROR);
  let offset = end - directorySize;
  let actualCount = 0;
  let fileCount = 0;
  let folderCount = 0;
  const checksums: number[] = [];
  if (offset < 0 || directoryOffset + directorySize > end) throw new Error(INVALID_ARCHIVE_ERROR);
  while (offset < end) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error(INVALID_ARCHIVE_ERROR);
    }
    if (++actualCount > MAX_FILES + MAX_FOLDERS) throw new Error(ENTRY_LIMIT_ERROR);
    const nameLength = view.getUint16(offset + 28, true);
    const nextOffset =
      offset +
      46 +
      nameLength +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
    if (nextOffset > end) throw new Error(INVALID_ARCHIVE_ERROR);
    const lastByte = nameLength > 0 ? view.getUint8(offset + 46 + nameLength - 1) : 0;
    const attributes = view.getUint32(offset + 38, true);
    const isDirectory =
      lastByte === 47 || (attributes & 16) !== 0 || ((attributes >>> 16) & 0xf000) === 0x4000;
    if (isDirectory) folderCount++;
    else fileCount++;
    if (fileCount > MAX_FILES || folderCount > MAX_FOLDERS) throw new Error(ENTRY_LIMIT_ERROR);
    if ((view.getUint16(offset + 8, true) & 1) !== 0) {
      throw new Error("Encrypted ZIP archives are not supported in ZIP preview.");
    }
    const compression = view.getUint16(offset + 10, true);
    if (compression !== 0 && compression !== 8) {
      throw new Error("This ZIP compression method is not supported in ZIP preview.");
    }
    if (
      view.getUint32(offset + 20, true) === 0xffffffff ||
      view.getUint32(offset + 24, true) === 0xffffffff ||
      view.getUint32(offset + 42, true) === 0xffffffff ||
      view.getUint16(offset + 34, true) === 0xffff
    ) {
      throw new Error("ZIP64 archives are not supported in ZIP preview.");
    }
    if (view.getUint16(offset + 34, true) !== 0) {
      throw new Error("Multi-part ZIP archives are not supported in ZIP preview.");
    }
    checksums.push(view.getInt32(offset + 16, true));
    offset = nextOffset;
  }
  if (offset !== end || actualCount !== count) throw new Error(INVALID_ARCHIVE_ERROR);
  return checksums;
}

function zipImageDimensions(bytes: Uint8Array) {
  const dimensions = readImageDimensions(bytes);
  if (!dimensions || bytes[0] !== 0x47) return dimensions;
  if (bytes.length < 13) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const packed = bytes[10]!;
  let offset = 13 + (packed & 0x80 ? 3 * (2 << (packed & 7)) : 0);
  let { width, height } = dimensions;
  let sawFrame = false;
  while (offset < bytes.length) {
    const block = bytes[offset++]!;
    if (block === 0x3b) return sawFrame ? { width, height } : null;
    if (block === 0x2c) {
      if (offset + 9 > bytes.length) return null;
      width = Math.max(width, view.getUint16(offset, true) + view.getUint16(offset + 4, true));
      height = Math.max(
        height,
        view.getUint16(offset + 2, true) + view.getUint16(offset + 6, true),
      );
      const imagePacked = bytes[offset + 8]!;
      offset += 9 + (imagePacked & 0x80 ? 3 * (2 << (imagePacked & 7)) : 0);
      if (offset >= bytes.length) return null;
      offset++;
      sawFrame = true;
    } else if (block === 0x21) {
      if (offset >= bytes.length) return null;
      offset++;
    } else {
      return null;
    }
    while (offset < bytes.length && bytes[offset] !== 0) offset += 1 + bytes[offset]!;
    if (offset >= bytes.length) return null;
    offset++;
  }
  return null;
}

function readFile(
  file: ZipFile,
  expectedCrc: number,
  mimeType: string,
  signal: AbortSignal,
): Promise<Blob> {
  signal.throwIfAborted();
  const stream = file.internalStream("uint8array");
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    let checksum = 0;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      stream.pause();
      chunks.length = 0;
      signal.removeEventListener("abort", abort);
      reject(error);
    };
    const abort = () => fail(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    stream.on("data", (chunk) => {
      if (settled) return;
      size += chunk.byteLength;
      if (size > MAX_FILE_BYTES) {
        fail(new Error("File preview supports files up to 10 MiB."));
        return;
      }
      checksum = crc32(chunk, checksum);
      chunks.push(chunk);
    });
    stream.on("error", () =>
      fail(new Error("Could not read this file from the ZIP. The file data is corrupt.")),
    );
    stream.on("end", () => {
      if (settled) return;
      if (checksum !== expectedCrc) {
        fail(new Error("Could not read this file from the ZIP. The file data is corrupt."));
        return;
      }
      if (mimeType.startsWith("image/")) {
        const header = new Uint8Array(
          chunks[0]?.[0] === 0x47 ? size : Math.min(size, IMAGE_DIMENSIONS_HEADER_BYTES),
        );
        let offset = 0;
        for (const chunk of chunks) {
          const part = chunk.subarray(0, header.length - offset);
          header.set(part, offset);
          offset += part.length;
          if (offset === header.length) break;
        }
        const dimensions = zipImageDimensions(header);
        if (!dimensions) {
          fail(new Error("Cannot safely preview this image. Download the ZIP to open it."));
          return;
        }
        if (
          dimensions.width > MAX_IMAGE_EDGE ||
          dimensions.height > MAX_IMAGE_EDGE ||
          dimensions.width * dimensions.height > MAX_IMAGE_PIXELS
        ) {
          fail(
            new Error(
              "Image preview supports up to 16 million pixels and 8,192 pixels per side. Download the ZIP to open it.",
            ),
          );
          return;
        }
      }
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve(new Blob(chunks, { type: mimeType }));
      chunks.length = 0;
    });
    queueMicrotask(() => {
      if (!settled) stream.resume();
    });
  });
}

export async function readZipPreviewResponse(
  response: Pick<Response, "ok" | "body">,
  signal: AbortSignal,
): Promise<Blob> {
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
    throw new Error("Could not load this ZIP file.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) return new Blob(chunks, { type: "application/zip" });
      size += value.byteLength;
      if (size > MAX_ARCHIVE_BYTES) throw new Error(ARCHIVE_LIMIT_ERROR);
      chunks.push(value as Uint8Array<ArrayBuffer>);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    chunks.length = 0;
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export async function loadZipPreview(blob: Blob, signal: AbortSignal) {
  signal.throwIfAborted();
  if (blob.size > MAX_ARCHIVE_BYTES) {
    throw new Error(ARCHIVE_LIMIT_ERROR);
  }
  const bytes = await withAbort(blob.arrayBuffer(), signal);
  const checksums = checkArchiveDirectory(bytes);
  const zip = new JSZip();
  const objects: { file: ZipFile; checksum: number }[] = [];
  zip.files = new Proxy(zip.files, {
    set(target, path, file: JSZip.JSZipObject) {
      objects.push({ file: file as ZipFile, checksum: checksums[objects.length]! });
      return Reflect.set(target, path, file);
    },
  });
  try {
    await withAbort(zip.loadAsync(bytes), signal);
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(INVALID_ARCHIVE_ERROR, { cause: error });
  }
  signal.throwIfAborted();
  const entries = new Map<string, ZipPreviewEntry>();
  const files = new Map<ZipPreviewEntry, { file: ZipFile; checksum: number }>();
  const occupied = new Set(
    objects.map(
      ({ file }) =>
        `${file.name.replaceAll("\\", "/").split("/").filter(Boolean).join("/")}${file.dir ? "/" : ""}`,
    ),
  );
  let folderCount = 0;
  const addEntry = (path: string, isDirectory: boolean, sizeBytes = 0) => {
    const parts = path.split("/").filter(Boolean);
    const name = parts.at(-1) ?? path;
    const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
    const entry: ZipPreviewEntry = {
      path,
      name,
      isDirectory,
      sizeBytes,
      mimeType: isDirectory
        ? null
        : (hostPreviewMimeTypeFromExtension(extension) ??
          (extension === ".bmp" ? "image/bmp" : null)),
    };
    if (isDirectory && !entries.has(path) && ++folderCount > MAX_FOLDERS)
      throw new Error(ENTRY_LIMIT_ERROR);
    entries.set(path, entry);
    return entry;
  };
  for (const object of objects) {
    const { file } = object;
    const parts = file.name.replaceAll("\\", "/").split("/").filter(Boolean);
    if (parts.length > MAX_FOLDERS + 1) throw new Error(ENTRY_LIMIT_ERROR);
    if (
      parts.length === 0 ||
      parts.some((part) => part === "__MACOSX" || part === ".DS_Store" || part.startsWith("._"))
    )
      continue;
    let path = `${parts.join("/")}${file.dir ? "/" : ""}`;
    if (!file.dir && entries.has(path)) {
      const name = parts.at(-1)!;
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const extension = dot > 0 ? name.slice(dot) : "";
      let suffix = 2;
      do {
        parts[parts.length - 1] = `${stem} (${suffix++})${extension}`;
        path = parts.join("/");
      } while (occupied.has(path) || occupied.has(`${path}/`));
      occupied.add(path);
    }
    for (let index = parts.length - 1; index > 0; index--) {
      const directory = `${parts.slice(0, index).join("/")}/`;
      if (entries.has(directory)) break;
      addEntry(directory, true);
    }
    const entry = addEntry(path, file.dir, file.dir ? 0 : file._data.uncompressedSize >>> 0);
    if (!file.dir) {
      files.set(entry, object);
      if (files.size > MAX_FILES) throw new Error(ENTRY_LIMIT_ERROR);
    }
  }
  const sortedEntries: readonly ZipPreviewEntry[] = [...entries.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  return {
    entries: sortedEntries,
    async readFile(entry: ZipPreviewEntry, fileSignal: AbortSignal) {
      fileSignal.throwIfAborted();
      const selected = files.get(entry);
      if (!selected) throw new Error("File preview is not available for this entry.");
      if (entry.sizeBytes > MAX_FILE_BYTES) {
        throw new Error("File preview supports files up to 10 MiB.");
      }
      return readFile(
        selected.file,
        selected.checksum,
        entry.mimeType ?? "application/octet-stream",
        fileSignal,
      );
    },
  };
}
