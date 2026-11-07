import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ByteSize from "effect/ByteSize";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { describe, expect, vi } from "vite-plus/test";

import { DarwinFileFlags, isCloudPlaceholder } from "./cloudPlaceholder.ts";

const nativeProbe = vi.hoisted(() => ({
  execFile:
    vi.fn<
      (
        file: string,
        args: string[],
        options: object,
        callback: (error: Error | null, stdout: string) => void,
      ) => { kill: () => boolean }
    >(),
}));
vi.mock("node:child_process", () => ({ execFile: nativeProbe.execFile }));

const info = (overrides: Partial<FileSystem.File.Info>): FileSystem.File.Info => ({
  type: "File",
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0n,
  ino: Option.none(),
  mode: 0o644,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: ByteSize.bytes(11_648),
  blksize: Option.none(),
  blocks: Option.some(24n),
  ...overrides,
});

describe("isCloudPlaceholder", () => {
  it.effect.each([
    [0x40000000, true],
    [0x40000020, true],
    [0x20, false],
    [0, false],
    [null, true],
  ] as const)("classifies zero-block files with flags %s", ([flags, expected]) =>
    Effect.gen(function* () {
      const result = yield* isCloudPlaceholder(
        info({ blocks: Option.some(0n) }),
        "darwin",
        "/skill",
      ).pipe(Effect.provideService(DarwinFileFlags, () => Effect.succeed(flags)));
      expect(result).toBe(expected);
    }),
  );

  it.effect.each([
    ["32\n", false],
    ["1073741856\n", true],
    ["invalid", true],
  ] as const)("reads native flags %s without reading contents", ([stdout, expected]) =>
    Effect.gen(function* () {
      nativeProbe.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
        callback(null, stdout);
        return { kill: () => true };
      });
      const result = yield* isCloudPlaceholder(
        info({ blocks: Option.some(0n) }),
        "darwin",
        "/a skill/SKILL.md",
      );
      expect(result).toBe(expected);
      expect(nativeProbe.execFile).toHaveBeenLastCalledWith(
        "/usr/bin/stat",
        ["-L", "-f", "%Uf", "--", "/a skill/SKILL.md"],
        { encoding: "utf8", timeout: 1000 },
        expect.any(Function),
      );
    }),
  );

  it.effect("skips an ambiguous candidate if spawning stat fails", () =>
    Effect.gen(function* () {
      nativeProbe.execFile.mockImplementationOnce(() => {
        throw new Error("spawn EPERM");
      });
      expect(yield* isCloudPlaceholder(info({ blocks: Option.some(0n) }), "darwin", "/skill")).toBe(
        true,
      );
    }),
  );

  it.effect("does not probe ordinary files or other platforms", () =>
    Effect.gen(function* () {
      for (const [metadata, platform] of [
        [info({}), "darwin"],
        [info({ size: ByteSize.bytes(0), blocks: Option.some(0n) }), "darwin"],
        [info({ type: "Directory", blocks: Option.some(0n) }), "darwin"],
        [info({ blocks: Option.none() }), "darwin"],
        [info({ blocks: Option.some(0n) }), "linux"],
        [info({ blocks: Option.some(0n) }), "win32"],
      ] as const) {
        const result = yield* isCloudPlaceholder(metadata, platform, "/skill").pipe(
          Effect.provideService(DarwinFileFlags, () => Effect.die("unexpected metadata probe")),
        );
        expect(result).toBe(false);
      }
    }),
  );
});
