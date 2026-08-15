import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  FILESYSTEM_BROWSE_MAX_LIMIT,
  FilesystemBrowseEntry,
  FilesystemBrowseError,
  FilesystemBrowseInput,
} from "./filesystem.ts";

describe("filesystem browse schemas", () => {
  it("decodes legacy and extended browse inputs", () => {
    const decode = Schema.decodeUnknownSync(FilesystemBrowseInput);
    expect(decode({ partialPath: "~/" })).toEqual({ partialPath: "~/" });
    expect(decode({ partialPath: "~/src", kinds: ["file", "directory"], limit: 50 })).toEqual({
      partialPath: "~/src",
      kinds: ["file", "directory"],
      limit: 50,
    });
    expect(() => decode({ partialPath: "~/", limit: FILESYSTEM_BROWSE_MAX_LIMIT + 1 })).toThrow();
  });

  it("accepts legacy entries without kind and new typed entries", () => {
    const decode = Schema.decodeUnknownSync(FilesystemBrowseEntry);
    expect(decode({ name: "src", fullPath: "/repo/src" })).toEqual({
      name: "src",
      fullPath: "/repo/src",
    });
    expect(decode({ name: "main.ts", fullPath: "/repo/main.ts", kind: "file" })).toEqual({
      name: "main.ts",
      fullPath: "/repo/main.ts",
      kind: "file",
    });
    expect(decode({ name: "src", fullPath: "/repo/src", kind: "directory" })).toEqual({
      name: "src",
      fullPath: "/repo/src",
      kind: "directory",
    });
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
