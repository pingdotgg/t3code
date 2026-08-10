import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { FilesystemBrowseError, FilesystemBrowseInput } from "./filesystem.ts";

describe("FilesystemBrowseInput", () => {
  const decodeInput = Schema.decodeUnknownSync(FilesystemBrowseInput);

  it("keeps name ordering compatible with clients that omit a sort order", () => {
    expect(decodeInput({ partialPath: "~/projects/" })).toEqual({
      partialPath: "~/projects/",
    });
  });

  it.each(["name", "modified"] as const)("accepts the %s sort order", (sortOrder) => {
    expect(decodeInput({ partialPath: "~/projects/", sortOrder }).sortOrder).toBe(sortOrder);
  });

  it("rejects unsupported sort orders", () => {
    expect(() => decodeInput({ partialPath: "~/projects/", sortOrder: "size" })).toThrow();
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
