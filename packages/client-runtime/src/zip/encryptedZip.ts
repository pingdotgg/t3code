import {
  ERR_ENCRYPTED,
  ERR_INVALID_PASSWORD,
  ERR_INVALID_CRC32,
  ERR_INVALID_COMPRESSED_DATA,
  ERR_INVALID_UNCOMPRESSED_SIZE,
  ERR_UNSUPPORTED_ENCRYPTION,
  ERR_UNSUPPORTED_COMPRESSION,
  Uint8ArrayReader,
  ZipReader,
  type FileEntry,
} from "@zip.js/zip.js/index-native.cjs";

import { ZipError } from "./zipError.ts";

export async function readEncryptedZip(
  bytes: ArrayBuffer,
  password: string,
  limits: {
    readonly entryLimit: number;
    readonly totalLimit: number;
    readonly xmlLimit: number;
    readonly markupLimit: number | undefined;
    readonly signal: AbortSignal | undefined;
    readonly decodeFileName: (name: Uint8Array) => string;
  },
) {
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(bytes)), {
    useWebWorkers: false,
    decodeText: (name, encoding, type) =>
      type === "filename" && encoding !== "utf-8" ? limits.decodeFileName(name) : undefined,
  });
  const files = new Map<
    string,
    { bytes: Uint8Array<ArrayBuffer>; date: Date; directory: boolean }
  >();
  let total = 0;
  let markup = 0;
  try {
    for (const entry of await reader.getEntries()) {
      limits.signal?.throwIfAborted();
      const name = entry.filename
        .split("/")
        .reduce<string[]>((parts, part) => {
          if (part === "..") parts.pop();
          else if (part && part !== ".") parts.push(part);
          return parts;
        }, [])
        .join("/");
      if (!name) continue;
      total += entry.uncompressedSize;
      if (
        total > limits.totalLimit ||
        entry.uncompressedSize > limits.entryLimit ||
        (name.endsWith(".xml") && entry.uncompressedSize > limits.xmlLimit)
      )
        throw new ZipError({ code: "archive-expanded-too-large" });
      const content = entry.directory
        ? new Uint8Array()
        : await readEntry(entry, password, limits.signal);
      if (limits.markupLimit !== undefined) {
        for (const byte of content) if (byte === 0x3c) markup++;
        if (markup > limits.markupLimit) throw new ZipError({ code: "archive-expanded-too-large" });
      }
      files.set(entry.directory ? `${name}/` : name, {
        bytes: content,
        date: entry.lastModDate,
        directory: entry.directory,
      });
    }
    return files;
  } catch (cause) {
    if (cause instanceof Error) {
      if (cause.message === ERR_INVALID_PASSWORD || cause.message === ERR_ENCRYPTED)
        throw new ZipError({ code: "password-incorrect" });
      if (
        cause.message === ERR_UNSUPPORTED_ENCRYPTION ||
        cause.message === ERR_UNSUPPORTED_COMPRESSION
      )
        throw new ZipError({ code: "encryption-unsupported" });
    }
    throw cause;
  } finally {
    await reader.close();
  }
}

async function readEntry(entry: FileEntry, password: string, signal?: AbortSignal) {
  const content = new Uint8Array(entry.uncompressedSize);
  let offset = 0;
  try {
    await entry.getData(
      new WritableStream<Uint8Array>({
        write(chunk) {
          if (offset + chunk.length > content.length)
            throw new ZipError({ code: "archive-expanded-too-large" });
          content.set(chunk, offset);
          offset += chunk.length;
        },
      }),
      {
        ...(entry.encrypted ? { password } : {}),
        checkCrc32: true,
        checkAuthenticationCode: true,
        ...(signal ? { signal } : {}),
      },
    );
  } catch (cause) {
    // ZipCrypto checks only one byte of the password before decompression.
    if (
      entry.encrypted &&
      entry.zipCrypto &&
      cause instanceof Error &&
      [ERR_INVALID_CRC32, ERR_INVALID_COMPRESSED_DATA, ERR_INVALID_UNCOMPRESSED_SIZE].includes(
        cause.message,
      )
    )
      throw new ZipError({ code: "password-incorrect" });
    throw cause;
  }
  return content;
}
