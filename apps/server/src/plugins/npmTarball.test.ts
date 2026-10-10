// @effect-diagnostics nodeBuiltinImport:off
import * as NodeZlib from "node:zlib";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { defaultNpmTarballLimits, readNpmTarball, type NpmTarballLimits } from "./npmTarball.ts";
import { makeTar, makeTarball, paxRecord, type TarEntry } from "./npmTarball.testkit.ts";

const read = (entries: ReadonlyArray<TarEntry>, limits?: NpmTarballLimits) =>
  readNpmTarball(makeTarball(entries), limits);

const refusal = (entries: ReadonlyArray<TarEntry>, limits?: NpmTarballLimits) =>
  read(entries, limits).pipe(Effect.flip);

const manifest: TarEntry = { path: "package/package.json", data: "{}" };

describe("readNpmTarball", () => {
  it.effect("reads files below the package root, long names and executable bits included", () =>
    Effect.gen(function* () {
      const deep = `package/${"nested/".repeat(20)}deep.js`;
      const files = yield* read([
        { path: "package/", type: "5" },
        manifest,
        { path: "package/dist/main.js", data: "exports.activate = () => {};" },
        { path: "package/bin/tool", data: "#!/bin/sh", mode: 0o755 },
        { path: deep, data: "deep" },
      ]);
      expect(files.map((file) => file.path)).toEqual([
        "package.json",
        "dist/main.js",
        "bin/tool",
        deep.slice("package/".length),
      ]);
      expect(files.find((file) => file.path === "bin/tool")?.executable).toBe(true);
      expect(files.find((file) => file.path === "dist/main.js")?.executable).toBe(false);
      expect(new TextDecoder().decode(files[1]!.data)).toBe("exports.activate = () => {};");
    }),
  );

  it.effect("ignores binary extended attributes, as macOS tar writes them", () =>
    Effect.gen(function* () {
      // `SCHILY.xattr.com.apple.provenance` carries raw bytes that are not UTF-8.
      const xattr = Buffer.concat([
        new TextEncoder().encode("SCHILY.xattr.com.apple.provenance="),
        Uint8Array.from([0x01, 0x00, 0x00, 0x37, 0xff, 0xfe]),
      ]);
      const files = yield* read([
        { ...manifest, pax: [xattr] },
        { path: "package/main.js", data: "x", pax: [xattr] },
      ]);
      expect(files.map((file) => file.path)).toEqual(["package.json", "main.js"]);
      const link = yield* refusal([
        manifest,
        { path: "package/link.js", type: "2", linkname: "/etc/hosts", pax: [xattr] },
      ]);
      expect(link.message).toMatch(/is a link/);
    }),
  );

  it.effect("reads GNU headers and directories that reserve space as their writers meant", () =>
    Effect.gen(function* () {
      // GNU keeps an access time where POSIX keeps the path prefix.
      const files = yield* read([
        { path: "package/", type: "5", format: "gnu" },
        { ...manifest, format: "gnu" },
        // A directory's size is space to reserve; no data follows its header.
        { path: "package/lib/", type: "5", size: 4096 },
        { path: "package/lib/main.js", data: "main", format: "gnu" },
      ]);
      expect(files.map((file) => file.path)).toEqual(["package.json", "lib/main.js"]);
      expect(new TextDecoder().decode(files[1]!.data)).toBe("main");
    }),
  );

  it.effect("refuses a global header that renames or resizes the entries after it", () =>
    Effect.gen(function* () {
      for (const record of ["path=package/other.js", "size=0"]) {
        const global: TarEntry = {
          path: "pax_global_header",
          type: "g",
          data: paxRecord(new TextEncoder().encode(record)),
        };
        const error = yield* refusal([global, manifest, { path: "package/main.js", data: "x" }]);
        expect(error.reason, record).toBe("npm-archive-unsafe");
        expect(error.message).toMatch(/global header/);
      }
      const comment: TarEntry = {
        path: "pax_global_header",
        type: "g",
        data: paxRecord(new TextEncoder().encode("comment=built by git")),
      };
      const files = yield* read([comment, manifest]);
      expect(files.map((file) => file.path)).toEqual(["package.json"]);
    }),
  );

  it.effect("refuses links, special files, and paths that leave the package", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [ReadonlyArray<TarEntry>, RegExp]> = [
        [[manifest, { path: "package/link.js", type: "2", linkname: "/etc/passwd" }], /is a link/],
        [
          [manifest, { path: "package/hard.js", type: "1", linkname: "package/package.json" }],
          /is a link/,
        ],
        [[manifest, { path: "package/device", type: "3" }], /not a regular file/],
        [[manifest, { path: "/etc/evil.js", data: "x" }], /not a relative path/],
        [[manifest, { path: "package/../../evil.js", data: "x" }], /leaves or names/],
        [[manifest, { path: "package/./main.js", data: "x" }], /leaves or names/],
        [[manifest, { path: "package\\..\\evil.js", data: "x" }], /not a relative path/],
        [[manifest, { path: "C:/evil.js", data: "x" }], /not a relative path/],
        // An NTFS alternate stream of an ordinary file, which the consent digest never reads.
        [[manifest, { path: "package/payload:code.mjs", data: "x" }], /has a colon/],
        [[manifest, { path: "package/lib:stream/x.js", data: "x" }], /has a colon/],
        [[manifest, { path: "package", data: "a file as the root" }], /outside the package/],
        // The same file twice on a case-insensitive disk, or a file that is also a directory.
        [
          [
            manifest,
            { path: "package/Main.js", data: "a" },
            { path: "package/main.js", data: "b" },
          ],
          /more than one entry/,
        ],
        [
          [manifest, { path: "package/lib", data: "a" }, { path: "package/lib/x.js", data: "b" }],
          /both a file and a directory/,
        ],
        [
          [manifest, { path: "package/lib/x.js", data: "a" }, { path: "package/lib", data: "b" }],
          /more than one entry/,
        ],
      ];
      for (const [entries, message] of cases) {
        const error = yield* refusal(entries);
        expect(error.reason, entries.at(-1)!.path).toBe("npm-archive-unsafe");
        expect(error.message).toMatch(message);
      }
    }),
  );

  it.effect("refuses a corrupt, truncated, or non-gzip archive", () =>
    Effect.gen(function* () {
      const tar = makeTar([manifest, { path: "package/main.js", data: "x".repeat(2000) }]);
      const corrupt = Buffer.from(tar);
      corrupt[0] = corrupt[0]! ^ 1;
      const truncated = tar.subarray(0, 512 + 1024);
      for (const bytes of [
        NodeZlib.gzipSync(corrupt),
        NodeZlib.gzipSync(truncated),
        new TextEncoder().encode("not gzip"),
      ]) {
        const error = yield* readNpmTarball(bytes).pipe(Effect.flip);
        expect(error.reason).toBe("npm-archive-unsafe");
      }
    }),
  );

  it.effect("stops at the file, size, and unpacked-size limits", () =>
    Effect.gen(function* () {
      const limits = {
        ...defaultNpmTarballLimits,
        maxTarballBytes: 1024 * 1024,
        maxFiles: 2,
        maxBytes: 1000,
      };
      const tooMany = yield* refusal(
        [manifest, { path: "package/a.js" }, { path: "package/b.js" }],
        limits,
      );
      expect(tooMany.reason).toBe("npm-too-large");
      const tooBig = yield* refusal([manifest, { path: "package/a.js", data: "x".repeat(1001) }], {
        ...limits,
        maxBytes: 1000,
      });
      expect(tooBig.reason).toBe("npm-too-large");
      // A small gzip that expands far past the bound is cut off while it is inflated.
      const bomb = NodeZlib.gzipSync(new Uint8Array(64 * 1024 * 1024));
      expect(bomb.length).toBeLessThan(128 * 1024);
      const inflated = yield* readNpmTarball(bomb, limits).pipe(Effect.flip);
      expect(inflated.reason).toBe("npm-too-large");
    }),
  );

  it.effect("bounds paths and headers before it builds anything from them", () =>
    Effect.gen(function* () {
      const limits = { ...defaultNpmTarballLimits, maxPathDepth: 8, maxPathBytes: 200 };
      // Long names travel in pax headers; both bounds apply to them before any directory is made.
      const deep = yield* refusal(
        [manifest, { path: `package/${"d/".repeat(8)}x.js`, data: "x" }],
        limits,
      );
      expect(deep.reason).toBe("npm-archive-unsafe");
      expect(deep.message).toMatch(/nested deeper than 8/);
      const long = yield* refusal(
        [manifest, { path: `package/${"n".repeat(200)}.js`, data: "x" }],
        limits,
      );
      expect(long.message).toMatch(/longer than 200 bytes/);
      const longDirectory = yield* refusal(
        [manifest, { path: `package/${"d/".repeat(8)}`, type: "5" }],
        limits,
      );
      expect(longDirectory.message).toMatch(/nested deeper than 8/);
      // A tiny gzip with a path thousands of segments deep is refused under the defaults too.
      const bomb = makeTarball([manifest, { path: `package/${"a/".repeat(5000)}x`, data: "x" }]);
      expect(bomb.length).toBeLessThan(1024);
      const refused = yield* readNpmTarball(bomb).pipe(Effect.flip);
      expect(refused.reason).toBe("npm-archive-unsafe");
      const header = yield* refusal([
        { ...manifest, pax: [new TextEncoder().encode(`comment=${"x".repeat(70 * 1024)}`)] },
      ]);
      expect(header.message).toMatch(/extended header that is too large/);
    }),
  );

  it.effect("counts directory and extended header entries against the entry limit", () =>
    Effect.gen(function* () {
      const limits = { ...defaultNpmTarballLimits, maxEntries: 10 };
      const directories = Array.from({ length: 10 }, (_, index) => ({
        path: `package/d${index}/`,
        type: "5",
      }));
      const tooMany = yield* refusal([manifest, ...directories], limits);
      expect(tooMany.reason).toBe("npm-too-large");
      expect(tooMany.message).toMatch(/more than 10 archive entries/);
      const files = yield* read([manifest, ...directories.slice(1)], limits);
      expect(files.map((file) => file.path)).toEqual(["package.json"]);
    }),
  );
});
