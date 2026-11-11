import { describe, expect, it } from "@effect/vitest";

import { cursorCloudWorkspacePath, parseCursorCloudWorkspacePath } from "./cursorCloud.ts";

describe("Cursor Cloud workspace paths", () => {
  it.each([
    [cursorCloudWorkspacePath("thread-1"), { threadId: "thread-1", relativePath: "" }],
    ["/.t3-cursor-cloud/thread-1/apps/web/", { threadId: "thread-1", relativePath: "apps/web" }],
    // path.resolve on a Windows server turns the mount into a drive path.
    [
      "C:\\.t3-cursor-cloud\\thread-1\\src\\a.ts",
      { threadId: "thread-1", relativePath: "src/a.ts" },
    ],
  ])("maps %s to its thread's VM workspace", (path, expected) => {
    expect(parseCursorCloudWorkspacePath(path)).toEqual(expected);
  });

  it.each(["/Users/me/.t3-cursor-cloud-notes", "/repo/.t3-cursor-cloud/thread-1", "/"])(
    "leaves host path %s alone",
    (path) => {
      expect(parseCursorCloudWorkspacePath(path)).toBeNull();
    },
  );
});
