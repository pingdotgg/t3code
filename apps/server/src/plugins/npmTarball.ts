// @effect-diagnostics nodeBuiltinImport:off -- Gunzips with node:zlib, whose maxOutputLength bounds the inflated size.
/**
 * Reads an npm package tarball into memory and refuses anything that could
 * land outside the package or that a digest could not describe.
 *
 * Only regular files and directories are accepted. Links, devices, absolute
 * paths, `..` or `.` segments, backslashes, colons, and two entries that would be the
 * same file on a case-insensitive disk are refused, never skipped or
 * rewritten. Like npm, the first path segment (`package/`) is dropped. The
 * whole archive is checked before the caller writes any of it. Parsing runs
 * on the server's event loop, so every header, path, and entry is bounded and
 * the work stays linear in the inflated size.
 */
import * as NodeZlib from "node:zlib";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface NpmTarballLimits {
  /** Compressed tarball size. */
  readonly maxTarballBytes: number;
  /** Same bounds the catalogue applies to the unpacked directory. */
  readonly maxFiles: number;
  readonly maxBytes: number;
  /** Every tar header counts: files, directories, and extended headers. */
  readonly maxEntries: number;
  /** UTF-8 bytes of one entry's path, and its number of segments. */
  readonly maxPathBytes: number;
  readonly maxPathDepth: number;
}

export const defaultNpmTarballLimits: NpmTarballLimits = {
  maxTarballBytes: 32 * 1024 * 1024,
  maxFiles: 10_000,
  maxBytes: 64 * 1024 * 1024,
  maxEntries: 40_000,
  maxPathBytes: 1024,
  maxPathDepth: 64,
};

export interface NpmTarballFile {
  /** Relative to the package root, `/`-separated. */
  readonly path: string;
  readonly data: Uint8Array;
  readonly executable: boolean;
}

class NpmTarballError extends Schema.TaggedError<NpmTarballError>()("NpmTarballError", {
  reason: Schema.Literals(["npm-too-large", "npm-archive-unsafe"]),
  message: Schema.String,
}) {}

const isNpmTarballError = Schema.is(NpmTarballError);

const BLOCK = 512;
/** A pax or GNU long-name header carries a path and some attributes, never more. */
const MAX_EXTENDED_HEADER_BYTES = 64 * 1024;

const unsafe = (message: string) => new NpmTarballError({ reason: "npm-archive-unsafe", message });
const tooLarge = (message: string) => new NpmTarballError({ reason: "npm-too-large", message });

const decoder = new TextDecoder("utf-8", { fatal: true });
const keyDecoder = new TextDecoder("utf-8");

const readString = (block: Uint8Array, start: number, length: number) => {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return decoder.decode(end === -1 ? field : field.subarray(0, end));
};

const readOctal = (block: Uint8Array, start: number, length: number) => {
  // A base-256 size is only needed past 8 GiB, far beyond any limit here.
  if ((block[start]! & 0x80) !== 0) return undefined;
  const text = readString(block, start, length).trim();
  return /^[0-7]+$/.test(text) ? Number.parseInt(text, 8) : text === "" ? 0 : undefined;
};

const checksumMatches = (block: Uint8Array) => {
  const expected = readOctal(block, 148, 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index++)
    sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
  return expected === sum;
};

/**
 * Parses pax `length key=value\n` records; only `path` and `size` matter here.
 * Other values stay undecoded: `SCHILY.xattr.*` values are raw bytes (macOS
 * tar writes one for every file).
 */
const readPax = (data: Uint8Array) => {
  const fields = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw unsafe("The tarball has a malformed extended header.");
    const length = Number.parseInt(decoder.decode(data.subarray(offset, space)), 10);
    if (
      !Number.isSafeInteger(length) ||
      length <= space - offset ||
      offset + length > data.length ||
      data[offset + length - 1] !== 0x0a
    )
      throw unsafe("The tarball has a malformed extended header.");
    const record = data.subarray(space + 1, offset + length - 1);
    const equals = record.indexOf(0x3d);
    if (equals === -1) throw unsafe("The tarball has a malformed extended header.");
    const key = keyDecoder.decode(record.subarray(0, equals));
    if (key === "path" || key === "size")
      fields.set(key, decoder.decode(record.subarray(equals + 1)));
    offset += length;
  }
  return fields;
};

/** The path below the package root, or `undefined` for the root itself. */
const packagePath = (raw: string, limits: NpmTarballLimits) => {
  if (Buffer.byteLength(raw) > limits.maxPathBytes)
    throw unsafe(`The tarball has an entry path longer than ${limits.maxPathBytes} bytes.`);
  if (raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw))
    throw unsafe(`The tarball entry ${JSON.stringify(raw)} is not a relative path.`);
  const segments = raw.replace(/\/$/, "").split("/");
  if (segments.length > limits.maxPathDepth)
    throw unsafe(`The tarball has an entry nested deeper than ${limits.maxPathDepth} directories.`);
  for (const segment of segments)
    if (segment === "" || segment === "." || segment === "..")
      throw unsafe(`The tarball entry ${JSON.stringify(raw)} leaves or names its own directory.`);
  // On NTFS `name:stream` writes a hidden stream that listing the directory never shows.
  if (raw.includes(":"))
    throw unsafe(`The tarball entry ${JSON.stringify(raw)} has a colon in its path.`);
  return segments.length === 1 ? undefined : segments.slice(1).join("/");
};

const parse = (tar: Uint8Array, limits: NpmTarballLimits) => {
  const files: Array<NpmTarballFile> = [];
  const filePaths = new Set<string>();
  const directoryPaths = new Set<string>();
  // Case and Unicode form both fold, so one entry cannot overwrite another on macOS or Windows.
  const key = (path: string) => path.normalize("NFC").toLowerCase();
  const addDirectory = (path: string) => {
    // Deepest first: a directory already seen had its own ancestors added with it.
    for (let end = path.length; end > 0; end = path.lastIndexOf("/", end - 1)) {
      const ancestor = key(path.slice(0, end));
      if (directoryPaths.has(ancestor)) return;
      if (filePaths.has(ancestor))
        throw unsafe(`The tarball uses ${path} as both a file and a directory.`);
      directoryPaths.add(ancestor);
    }
  };
  let entries = 0;
  let totalBytes = 0;
  let pax = new Map<string, string>();
  let longName: string | undefined;
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) return files;
    if (!checksumMatches(header)) throw unsafe("The tarball is corrupt (a header checksum fails).");
    if (++entries > limits.maxEntries)
      throw tooLarge(`The package has more than ${limits.maxEntries} archive entries.`);
    const type = String.fromCharCode(header[156]!);
    const declared = readOctal(header, 124, 12);
    const size = pax.has("size") ? Number(pax.get("size")) : declared;
    if (size === undefined || !Number.isSafeInteger(size) || size < 0)
      throw unsafe("The tarball has an entry with an unreadable size.");
    // A directory's size is space to reserve; no data follows its header.
    const dataSize = type === "5" ? 0 : size;
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + dataSize;
    if (dataEnd > tar.length) throw unsafe("The tarball ends in the middle of an entry.");
    const data = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(dataSize / BLOCK) * BLOCK;

    if ((type === "x" || type === "g" || type === "L") && size > MAX_EXTENDED_HEADER_BYTES)
      throw unsafe("The tarball has an extended header that is too large.");
    if (type === "x") {
      pax = readPax(data);
      continue;
    }
    if (type === "g") {
      // Global attributes would apply to every later entry; this reader does not apply them.
      const global = readPax(data);
      if (global.has("path") || global.has("size"))
        throw unsafe("The tarball sets a path or size in a global header.");
      continue;
    }
    if (type === "L") {
      longName = readString(data, 0, data.length);
      continue;
    }
    // Only POSIX ustar (magic `ustar` NUL, version `00`) has a prefix; GNU keeps an access time there.
    const prefix =
      keyDecoder.decode(header.subarray(257, 265)) === "ustar\u000000"
        ? readString(header, 345, 155)
        : "";
    const name = readString(header, 0, 100);
    const raw = pax.get("path") ?? longName ?? (prefix === "" ? name : `${prefix}/${name}`);
    pax = new Map();
    longName = undefined;

    if (type === "1" || type === "2" || type === "K")
      throw unsafe(`The tarball entry ${JSON.stringify(raw)} is a link.`);
    if (type === "5") {
      const path = packagePath(raw, limits);
      if (path !== undefined) {
        if (filePaths.has(key(path)))
          throw unsafe(`The tarball uses ${path} as both a file and a directory.`);
        addDirectory(path);
      }
      continue;
    }
    if (type !== "0" && type !== "\0" && type !== "7")
      throw unsafe(`The tarball entry ${JSON.stringify(raw)} is not a regular file.`);
    const path = packagePath(raw, limits);
    if (path === undefined)
      throw unsafe(`The tarball entry ${JSON.stringify(raw)} is outside the package directory.`);
    const fileKey = key(path);
    if (filePaths.has(fileKey) || directoryPaths.has(fileKey))
      throw unsafe(`The tarball has more than one entry for ${path}.`);
    const parent = path.lastIndexOf("/");
    if (parent !== -1) addDirectory(path.slice(0, parent));
    filePaths.add(fileKey);
    totalBytes += size;
    if (files.length + 1 > limits.maxFiles)
      throw tooLarge(`The package has more than ${limits.maxFiles} files.`);
    if (totalBytes > limits.maxBytes)
      throw tooLarge(`The package unpacks to more than ${limits.maxBytes} bytes.`);
    const mode = readOctal(header, 100, 8) ?? 0o644;
    files.push({ path, data, executable: (mode & 0o111) !== 0 });
  }
  throw unsafe("The tarball ends without its end-of-archive marker.");
};

const gunzip = (tarball: Uint8Array, maxOutputLength: number) =>
  Effect.callback<Buffer, NpmTarballError>((resume) => {
    NodeZlib.gunzip(tarball, { maxOutputLength }, (error, result) =>
      resume(
        error === null
          ? Effect.succeed(result)
          : Effect.fail(
              (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE"
                ? tooLarge(`The package unpacks to more than ${maxOutputLength} bytes.`)
                : unsafe("The tarball is not a valid gzip file."),
            ),
      ),
    );
  });

/** Unpacks `tarball` (gzip) in memory into the files it would create. */
export const readNpmTarball = (
  tarball: Uint8Array,
  limits: NpmTarballLimits = defaultNpmTarballLimits,
) =>
  // Every entry, directories and extended headers too, gets 1.5 KiB for its header, padding,
  // and a pax path; one 10 KiB tar record covers the end-of-archive padding.
  gunzip(tarball, limits.maxBytes + limits.maxEntries * 3 * BLOCK + 20 * BLOCK).pipe(
    Effect.flatMap((tar) =>
      Effect.try({
        try: () => parse(tar, limits),
        catch: (cause) =>
          isNpmTarballError(cause)
            ? cause
            : unsafe("The tarball has an entry name that is not valid UTF-8."),
      }),
    ),
    Effect.withSpan("npmTarball.read"),
  );
