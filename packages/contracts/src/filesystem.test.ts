import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { FilesystemBrowseError, FilesystemGetMetadataInput } from "./filesystem.ts";

describe("FilesystemGetMetadataInput", () => {
  const decode = Schema.decodeUnknownSync(FilesystemGetMetadataInput);
  it("bounds request size and path lengths", () => {
    expect(() => decode({ paths: [] })).toThrow();
    expect(() => decode({ paths: Array.from({ length: 65 }, () => "/file") })).toThrow();
    expect(() => decode({ paths: ["/" + "x".repeat(512)] })).toThrow();
    expect(decode({ paths: Array.from({ length: 64 }, () => "/file") }).paths).toHaveLength(64);
  });
});

describe("FilesystemBrowseError", () => {
  it("derives a stable message from browse context while retaining the cause", () => {
    const cause = new Error("sensitive filesystem detail");
    const error = new FilesystemBrowseError({
      cwd: "/workspace",
      partialPath: "./src/mai",
      failure: "read_directory_failed",
      parentPath: "/workspace/src",
      cause,
    });

    expect(error.message).toBe("Failed to browse filesystem path './src/mai' from '/workspace'.");
    expect(error.message).not.toContain(cause.message);
    expect(error.cause).toBe(cause);
  });

  it("decodes legacy message-only errors during rolling upgrades", () => {
    const decodeError = Schema.decodeUnknownSync(FilesystemBrowseError);
    const error = decodeError({
      _tag: "FilesystemBrowseError",
      message: "Legacy filesystem browse failure.",
    });

    expect(error.message).toBe("Legacy filesystem browse failure.");
    expect(error.partialPath).toBeUndefined();
    expect(error.failure).toBeUndefined();
  });
});
