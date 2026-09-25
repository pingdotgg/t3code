import * as Effect from "effect/Effect";
import { createWriteStream } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { posix } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { verifiedFileChunks, type VerifiedFile } from "./ArtifactFile.ts";

/**
 * Node/Bun boundary for filesystem operations that Effect's portable
 * FileSystem service cannot currently express: incremental directory handles
 * and streaming a verified file descriptor through gzip.
 */

export interface ArchiveTarFileEntry {
  readonly type: "file";
  readonly name: string;
  readonly mode: number;
  readonly file: VerifiedFile;
}

export interface ArchiveTarSymlinkEntry {
  readonly type: "symlink";
  readonly name: string;
  readonly mode: number;
  readonly linkname: string;
}

export type ArchiveTarEntry = ArchiveTarFileEntry | ArchiveTarSymlinkEntry;

export interface SecureDirectoryEntry {
  readonly name: string;
  readonly type: "Directory" | "File" | "SymbolicLink" | "Other";
}

interface CloseableDirectoryHandle {
  readonly close: () => void | Promise<void>;
}

export const closeDirectoryHandle = async (
  handle: CloseableDirectoryHandle,
) => {
  try {
    await handle.close();
  } catch {
    // Async directory iteration closes the handle when it exits. Ignore both
    // Node's already-closed rejection and Bun's equivalent synchronous error.
  }
};

const entryLimitError = (maxEntries: number) =>
  new Error(
    `Compute artifact exceeds the ${maxEntries} entry safety limit. Narrow the artifact directory or add ignore patterns.`,
  );

export const readDirectoryEntriesSecure = (options: {
  readonly directory: string;
  readonly relativePrefix: string;
  readonly ignore: readonly RegExp[];
  readonly entriesAlreadyObserved: number;
  readonly maxEntries: number;
}) =>
  Effect.tryPromise({
    try: async () => {
      const before = await lstat(options.directory, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) {
        throw new Error(
          `Compute artifact directory changed before traversal: ${options.relativePrefix || "."}`,
        );
      }
      const handle = await opendir(options.directory);
      const entries: SecureDirectoryEntry[] = [];
      let observedEntries = 0;
      try {
        for await (const entry of handle) {
          if (entry.name.includes("\\")) {
            throw new Error(
              `Compute artifact entry contains an unsupported backslash: ${options.relativePrefix || "."}`,
            );
          }
          const name = entry.name;
          if (name.length === 0) continue;
          const relativeName = options.relativePrefix
            ? `${options.relativePrefix}/${name}`
            : name;
          observedEntries += 1;
          if (
            options.entriesAlreadyObserved + observedEntries >
            options.maxEntries
          ) {
            throw entryLimitError(options.maxEntries);
          }
          if (options.ignore.some((pattern) => pattern.test(relativeName))) {
            continue;
          }
          entries.push({
            name,
            type: entry.isSymbolicLink()
              ? "SymbolicLink"
              : entry.isDirectory()
                ? "Directory"
                : entry.isFile()
                  ? "File"
                  : "Other",
          });
        }
      } finally {
        await closeDirectoryHandle(handle);
      }
      const after = await lstat(options.directory, { bigint: true });
      if (
        !after.isDirectory() ||
        after.isSymbolicLink() ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      ) {
        throw new Error(
          `Compute artifact directory changed during traversal: ${options.relativePrefix || "."}`,
        );
      }
      return {
        entries: entries.sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        ),
        observedEntries,
      };
    },
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  });

export const writeCompressedArchiveSecure = (
  archivePath: string,
  entries: readonly ArchiveTarEntry[],
  manifest: Uint8Array,
  maxCompressedBytes: number,
) =>
  Effect.tryPromise({
    try: (signal) => {
      let compressedBytes = 0;
      const compressedByteLimit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          compressedBytes += chunk.byteLength;
          if (compressedBytes > maxCompressedBytes) {
            callback(
              new Error(
                `Prisma compute archive exceeds the ${maxCompressedBytes} byte compressed upload safety limit.`,
              ),
            );
            return;
          }
          callback(null, chunk);
        },
      });
      return pipeline(
        Readable.from(tarChunks(entries, manifest), { objectMode: false }),
        createGzip(),
        compressedByteLimit,
        createWriteStream(archivePath, { flags: "w", mode: 0o600 }),
        { signal },
      );
    },
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  });

export const isArchivedRegularFile = (
  entries: readonly ArchiveTarEntry[],
  entrypointName: string,
) => {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const visited = new Set<string>();
  let currentName = entrypointName;
  while (!visited.has(currentName)) {
    visited.add(currentName);
    const entry = byName.get(currentName);
    if (entry?.type === "file") return true;
    if (entry?.type !== "symlink") return false;
    const target = posix.normalize(
      posix.join(posix.dirname(currentName), entry.linkname),
    );
    if (target === ".." || target.startsWith("../") || target.startsWith("/")) {
      return false;
    }
    currentName = target;
  }
  return false;
};

async function* tarChunks(
  entries: readonly ArchiveTarEntry[],
  manifest: Uint8Array,
): AsyncGenerator<Uint8Array> {
  for (const entry of entries) {
    if (entry.type === "symlink") {
      yield createHeader({
        name: entry.name,
        mode: entry.mode,
        size: 0,
        type: "symlink",
        linkname: entry.linkname,
      });
      continue;
    }

    yield createHeader({
      name: entry.name,
      mode: entry.mode,
      size: entry.file.size,
      type: "file",
    });
    let emitted = 0;
    for await (const chunk of verifiedFileChunks(entry.file)) {
      emitted += chunk.byteLength;
      yield chunk;
    }
    if (emitted !== entry.file.size) {
      throw new Error(
        `Compute artifact file '${entry.name}' changed while the archive was being created.`,
      );
    }
    const padding = paddingLength(entry.file.size);
    if (padding > 0) yield new Uint8Array(padding);
  }

  yield createHeader({
    name: "compute.manifest.json",
    mode: 0o644,
    size: manifest.byteLength,
    type: "file",
  });
  yield manifest;
  const manifestPadding = paddingLength(manifest.byteLength);
  if (manifestPadding > 0) yield new Uint8Array(manifestPadding);
  yield new Uint8Array(1024);
}

const createHeader = (entry: {
  readonly name: string;
  readonly mode: number;
  readonly size: number;
  readonly type: "file" | "symlink";
  readonly linkname?: string;
}) => {
  const header = new Uint8Array(512);
  const { name, prefix } = splitTarName(entry.name);
  if (entry.linkname && byteLength(entry.linkname) > 100) {
    throw new Error(
      `Archive symlink target is too long for tar header: ${entry.linkname}`,
    );
  }

  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, entry.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, entry.type === "symlink" ? "2" : "0");
  if (entry.linkname) writeString(header, 157, 100, entry.linkname);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  writeString(header, 265, 32, "alchemy");
  writeString(header, 297, 32, "alchemy");
  if (prefix) writeString(header, 345, 155, prefix);

  const checksum = header.reduce((sum, value) => sum + value, 0);
  writeChecksum(header, checksum);
  return header;
};

const splitTarName = (name: string): { name: string; prefix?: string } => {
  if (byteLength(name) <= 100) return { name };
  const slashIndexes = Array.from(name.matchAll(/\//g), (match) => match.index);
  for (const index of slashIndexes.reverse()) {
    if (index === undefined) continue;
    const prefix = name.slice(0, index);
    const suffix = name.slice(index + 1);
    if (byteLength(prefix) <= 155 && byteLength(suffix) <= 100) {
      return { name: suffix, prefix };
    }
  }
  throw new Error(`Archive path is too long for tar header: ${name}`);
};

const byteLength = (value: string) => new TextEncoder().encode(value).length;

const writeString = (
  buffer: Uint8Array,
  offset: number,
  length: number,
  value: string,
) => {
  const bytes = new TextEncoder().encode(value);
  buffer.set(bytes.slice(0, length), offset);
};

const writeOctal = (
  buffer: Uint8Array,
  offset: number,
  length: number,
  value: number,
) => {
  const text = value
    .toString(8)
    .padStart(length - 1, "0")
    .slice(0, length - 1);
  writeString(buffer, offset, length, `${text}\0`);
};

const writeChecksum = (buffer: Uint8Array, checksum: number) => {
  const text = checksum.toString(8).padStart(6, "0").slice(0, 6);
  writeString(buffer, 148, 8, `${text}\0 `);
};

const paddingLength = (size: number) => (512 - (size % 512)) % 512;
