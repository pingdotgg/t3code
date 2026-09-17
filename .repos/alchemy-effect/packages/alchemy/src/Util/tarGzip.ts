/**
 * Gzipped ustar of a directory. Used to upload a generated Docker
 * context (Railway `/up`, and any other gzip-tarball consumer).
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as zlib from "node:zlib";

const encoder = new TextEncoder();

const pad512 = (size: number) => (512 - (size % 512)) % 512;

const writeBytes = (
  buf: Uint8Array,
  offset: number,
  value: string,
  length: number,
) => {
  const bytes = encoder.encode(value);
  buf.set(bytes.subarray(0, length), offset);
};

const writeOctal = (
  buf: Uint8Array,
  offset: number,
  value: number,
  length: number,
) => {
  writeBytes(
    buf,
    offset,
    `${value.toString(8).padStart(length - 1, "0")}\0`,
    length,
  );
};

const headerBlock = (input: {
  name: string;
  size: number;
  type: string;
  mode: number;
  prefix?: string;
}): Uint8Array => {
  const buf = new Uint8Array(512);
  writeBytes(buf, 0, input.name, 100);
  writeOctal(buf, 100, input.mode, 8);
  writeOctal(buf, 108, 0, 8);
  writeOctal(buf, 116, 0, 8);
  writeOctal(buf, 124, input.size, 12);
  writeOctal(buf, 136, Math.floor(Date.now() / 1000), 12);
  for (let i = 148; i < 156; i++) buf[i] = 0x20;
  buf[156] = input.type.charCodeAt(0);
  writeBytes(buf, 257, "ustar", 6);
  buf[262] = 0;
  writeBytes(buf, 263, "00", 2);
  if (input.prefix !== undefined) {
    writeBytes(buf, 345, input.prefix, 155);
  }
  let sum = 0;
  for (const byte of buf) sum += byte;
  writeBytes(buf, 148, `${sum.toString(8).padStart(6, "0")}\0 `, 8);
  return buf;
};

const splitUstarName = (
  rel: string,
): { name: string; prefix?: string } | undefined => {
  if (rel.length <= 100) return { name: rel };
  for (let i = rel.length - 101; i >= 1; i--) {
    if (rel[i] !== "/") continue;
    const prefix = rel.slice(0, i);
    const name = rel.slice(i + 1);
    if (prefix.length <= 155 && name.length > 0 && name.length <= 100) {
      return { prefix, name };
    }
  }
  return undefined;
};

const gnuLongLink = (name: string): Uint8Array[] => {
  const bytes = encoder.encode(`${name}\0`);
  const header = headerBlock({
    name: "././@LongLink",
    size: bytes.length,
    type: "L",
    mode: 0,
  });
  const pad = pad512(bytes.length);
  return pad > 0 ? [header, bytes, new Uint8Array(pad)] : [header, bytes];
};

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = chunks.reduce((n, chunk) => n + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

type WalkEntry = {
  rel: string;
  abs: string;
  dir: boolean;
};

const walkDirectory = (
  root: string,
): Effect.Effect<WalkEntry[], unknown, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files: WalkEntry[] = [];
    const walk = (dir: string, rel: string): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const entries = [...(yield* fs.readDirectory(dir))].sort();
        for (const entry of entries) {
          const abs = path.join(dir, entry);
          const childRel = rel.length === 0 ? entry : `${rel}/${entry}`;
          const posixRel = childRel.replaceAll("\\", "/");
          const stat = yield* fs.stat(abs);
          if (stat.type === "Directory") {
            files.push({ rel: posixRel, abs, dir: true });
            yield* walk(abs, posixRel);
          } else if (stat.type === "File") {
            files.push({ rel: posixRel, abs, dir: false });
          }
        }
      });
    yield* walk(root, "");
    return files;
  });

const fileBlocks = (
  rel: string,
  size: number,
  type: "0" | "5",
  mode: number,
): Uint8Array[] => {
  const split = splitUstarName(rel);
  if (split === undefined) {
    return [
      ...gnuLongLink(rel),
      headerBlock({
        name: rel.slice(0, 100),
        size,
        type,
        mode,
      }),
    ];
  }
  return [headerBlock({ ...split, size, type, mode })];
};

/**
 * Pack `root` into a gzipped tar (ustar + GNU long-name). Paths are
 * relative to `root` with POSIX separators.
 */
export const tarGzipDirectory = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const files = yield* walkDirectory(root);
  const chunks: Uint8Array[] = [];
  for (const file of files) {
    if (file.dir) {
      chunks.push(...fileBlocks(`${file.rel}/`, 0, "5", 0o755));
      continue;
    }
    const content = yield* fs.readFile(file.abs);
    chunks.push(...fileBlocks(file.rel, content.byteLength, "0", 0o644));
    chunks.push(content);
    const pad = pad512(content.byteLength);
    if (pad > 0) chunks.push(new Uint8Array(pad));
  }
  chunks.push(new Uint8Array(1024));
  const tar = concat(chunks);
  return yield* Effect.sync(() => zlib.gzipSync(tar));
});
