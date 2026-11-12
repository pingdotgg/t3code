// @effect-diagnostics nodeBuiltinImport:off
// Effect has no inflate, and Azure's blob batch only comes as a deflate zip.
import * as NodeZlib from "node:zlib";

import type { AzureDevOpsItemContent } from "./azureDevOpsPullRequestJson.ts";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;
const ZIP64_MARKER = 0xffffffff;

const entryName = new TextDecoder();

/**
 * The entries of the zip Azure's Blobs API answers with, keyed by lowercase blob id. Azure streams
 * entries with data descriptors, so sizes come from the central directory. Null for an archive
 * this cannot read; an entry over `maxEntryBytes`, past `maxTotalBytes` in all, or in another method
 * is left out.
 */
export function readBlobZip(
  zip: Uint8Array,
  maxEntryBytes: number,
  maxTotalBytes: number,
): ReadonlyMap<string, Uint8Array> | null {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // The end record is 22 bytes followed by a comment of at most 65,535.
  let end = -1;
  for (let at = zip.length - 22; at >= 0 && at >= zip.length - 22 - 0xffff; at -= 1) {
    if (view.getUint32(at, true) === END_OF_CENTRAL_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end === -1) return null;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count === 0xffff || at === ZIP64_MARKER) return null;

  const entries = new Map<string, Uint8Array>();
  let total = 0;
  for (let entry = 0; entry < count; entry += 1) {
    if (at + 46 > zip.length || view.getUint32(at, true) !== CENTRAL_DIRECTORY_ENTRY) return null;
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = entryName.decode(zip.subarray(at + 46, at + 46 + nameLength)).toLowerCase();
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (compressedSize === ZIP64_MARKER || size === ZIP64_MARKER || local === ZIP64_MARKER) {
      return null;
    }
    if (local + 30 > zip.length || view.getUint32(local, true) !== LOCAL_FILE_HEADER) return null;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + compressedSize > zip.length) return null;
    if (size > maxEntryBytes || total + size > maxTotalBytes) continue;
    const data = zip.subarray(start, start + compressedSize);
    if (method === STORED) {
      if (compressedSize !== size) return null;
      entries.set(name, data);
      total += size;
    } else if (method === DEFLATED) {
      try {
        const inflated = NodeZlib.inflateRawSync(data, { maxOutputLength: maxEntryBytes });
        if (inflated.length !== size) return null;
        entries.set(name, inflated);
        total += size;
      } catch {
        return null;
      }
    }
  }
  return entries;
}

/** Strips a UTF-8 BOM, as Azure's `content` does. */
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * A blob's text as Azure's item read would give it, or null where Azure decodes the bytes itself
 * (UTF-16, or text that is not UTF-8 such as Windows-1252) and only that read is faithful.
 */
export function blobContent(bytes: Uint8Array): AzureDevOpsItemContent | null {
  const utf16 =
    (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
  if (utf16) return null;
  // Azure flags a binary on the same evidence.
  if (bytes.includes(0)) return { contents: "", isBinary: true };
  try {
    return { contents: strictUtf8.decode(bytes), isBinary: false };
  } catch {
    return null;
  }
}
