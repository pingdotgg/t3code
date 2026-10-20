import * as ByteSize from "effect/ByteSize";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { isCloudPlaceholder } from "./cloudPlaceholder.ts";

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
  it("matches a macOS file with a size but no blocks on disk", () => {
    expect(isCloudPlaceholder(info({ blocks: Option.some(0n) }), "darwin")).toBe(true);
  });

  it("does not match a file whose data is on disk", () => {
    expect(isCloudPlaceholder(info({}), "darwin")).toBe(false);
  });

  it("does not match an empty file, a directory, or unknown blocks", () => {
    expect(
      isCloudPlaceholder(info({ size: ByteSize.bytes(0), blocks: Option.some(0n) }), "darwin"),
    ).toBe(false);
    expect(isCloudPlaceholder(info({ type: "Directory", blocks: Option.some(0n) }), "darwin")).toBe(
      false,
    );
    expect(isCloudPlaceholder(info({ blocks: Option.none() }), "darwin")).toBe(false);
  });

  it("only applies on macOS, where zero blocks means no local data", () => {
    expect(isCloudPlaceholder(info({ blocks: Option.some(0n) }), "linux")).toBe(false);
    expect(isCloudPlaceholder(info({ blocks: Option.some(0n) }), "win32")).toBe(false);
  });
});
