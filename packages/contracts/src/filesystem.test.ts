import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { FilesystemBrowseError, FilesystemBrowseInput } from "./filesystem.ts";

const decodeInput = Schema.decodeUnknownSync(FilesystemBrowseInput);
const encodeInput = Schema.encodeSync(FilesystemBrowseInput);

describe("FilesystemBrowseInput", () => {
  it("keeps directory readability validation opt-in for existing clients", () => {
    expect(decodeInput({ partialPath: "/workspace/" })).not.toHaveProperty(
      "requireReadableDirectory",
    );
  });

  it.each([true, false])("preserves readability validation mode %s across the wire", (required) => {
    const input = { partialPath: "/workspace/", requireReadableDirectory: required };
    expect(encodeInput(decodeInput(input))).toEqual(input);
  });

  it("rejects non-boolean readability validation modes", () => {
    expect(() =>
      decodeInput({ partialPath: "/workspace/", requireReadableDirectory: "true" }),
    ).toThrow();
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
