import * as zlib from "node:zlib";
import { describe, expect, it } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { tarGzipDirectory } from "@/Util/tarGzip.ts";

// Minimal ustar + GNU long-name reader: returns each entry's full path.
const entryNames = (tar: Uint8Array): string[] => {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const field = (offset: number, length: number) => {
    const bytes = tar.subarray(offset, offset + length);
    const end = bytes.indexOf(0);
    return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
  };
  const names: string[] = [];
  let longName: string | undefined;
  for (let header = 0; header + 512 <= tar.byteLength;) {
    if (tar.subarray(header, header + 512).every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(header + 124, 12), 8);
    const type = String.fromCharCode(tar[header + 156]!);
    const body = header + 512;
    const name = field(header, 100);
    const prefix = field(header + 345, 155);
    header = body + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = field(body, size);
      continue;
    }
    names.push(longName ?? (prefix.length > 0 ? `${prefix}/${name}` : name));
    longName = undefined;
  }
  return names;
};

describe("tarGzipDirectory", { tags: ["unit", "local"] }, () => {
  it.effect("packs a Dockerfile and nested files into a gzipped ustar", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "alchemy-tar-" });
      yield* fs.writeFileString(path.join(dir, "Dockerfile"), "FROM oven/bun:1\n");
      yield* fs.makeDirectory(path.join(dir, "dist"), { recursive: true });
      yield* fs.writeFileString(path.join(dir, "dist", "index.html"), "<h1>ok</h1>\n");
      const gz = yield* tarGzipDirectory(dir);
      expect(gz.byteLength).toBeGreaterThan(80);
      const tar = yield* Effect.sync(() => zlib.gunzipSync(gz));
      const latin1 = new TextDecoder("latin1").decode(tar);
      expect(latin1).toContain("Dockerfile");
      expect(latin1).toContain("index.html");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps non-ASCII names longer than 100 UTF-8 bytes intact", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "alchemy-tar-" });
      // 44 UTF-16 code units, 124 UTF-8 bytes.
      const flat = `${"資料".repeat(20)}.txt`;
      // 155 bytes in total: split across the ustar prefix and name fields.
      const nestedDir = "目录".repeat(10);
      const nestedFile = `${"文件".repeat(15)}.txt`;
      // Too long for prefix + name: needs a GNU long-name entry.
      const longFile = `${"長".repeat(60)}.txt`;
      yield* fs.writeFileString(path.join(dir, flat), "a");
      yield* fs.makeDirectory(path.join(dir, nestedDir));
      yield* fs.writeFileString(path.join(dir, nestedDir, nestedFile), "b");
      yield* fs.writeFileString(path.join(dir, longFile), "c");
      const gz = yield* tarGzipDirectory(dir);
      const tar = yield* Effect.sync(() => zlib.gunzipSync(gz));
      expect(entryNames(tar).sort()).toEqual(
        [flat, `${nestedDir}/`, `${nestedDir}/${nestedFile}`, longFile].sort(),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
