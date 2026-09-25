import * as Effect from "effect/Effect";
import type { Zippable } from "fflate";
import { Buffer } from "node:buffer";

export interface ZipFile {
  path: string;
  content: string | Uint8Array<ArrayBufferLike>;
  /**
   * Unix file mode to record in the archive entry (e.g. `0o755` to keep an
   * executable bit). Omit to use the archiver's default.
   */
  mode?: number;
}

// ZIP timestamps use local calendar fields; local midnight keeps the encoded
// date identical in every timezone, including those west of UTC.
const archiveDate = new Date(1980, 0, 1);

export const zipCode = Effect.fn(function* (
  content: string | Uint8Array<ArrayBufferLike>,
  files?: ReadonlyArray<ZipFile>,
) {
  return yield* zipFiles([{ path: "index.mjs", content }, ...(files ?? [])]);
});

/**
 * Package `files` into a deterministic zip archive: entries are sorted by
 * path and stamped with a fixed timestamp so identical inputs always produce
 * identical bytes.
 */
export const zipFiles = Effect.fn(function* (files: ReadonlyArray<ZipFile>) {
  const { zipSync, strToU8 } = yield* Effect.promise(() => import("fflate"));
  const entries: Zippable = Object.create(null);
  for (const file of [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    entries[file.path] = [
      typeof file.content === "string" ? strToU8(file.content) : file.content,
      { attrs: (file.mode ?? 0o100644) << 16 },
    ];
  }
  return Buffer.from(zipSync(entries, { mtime: archiveDate, os: 3 }));
});
