import { describe, expect, it } from "vite-plus/test";

import { buildThreadCopyMenuItem, resolveThreadCopy } from "./thread-copy-menu";

const thread = { id: "thread-1", branch: "feature/x", worktreePath: "/wt/x" };

describe("buildThreadCopyMenuItem", () => {
  it("lists path, branch, and thread ID for a thread with a branch", () => {
    expect(buildThreadCopyMenuItem(thread).subactions?.map((item) => item.id)).toEqual([
      "copy-path",
      "copy-branch",
      "copy-thread-id",
    ]);
  });

  it("omits branch when the thread has none", () => {
    expect(buildThreadCopyMenuItem({ branch: null }).subactions?.map((item) => item.id)).toEqual([
      "copy-path",
      "copy-thread-id",
    ]);
  });
});

describe("resolveThreadCopy", () => {
  it("prefers the worktree path and falls back to the workspace root", () => {
    expect(resolveThreadCopy("copy-path", thread, "/root")?.value).toBe("/wt/x");
    expect(resolveThreadCopy("copy-path", { ...thread, worktreePath: null }, "/root")?.value).toBe(
      "/root",
    );
  });

  it("reports a missing path as a null value", () => {
    expect(resolveThreadCopy("copy-path", { ...thread, worktreePath: null }, undefined)).toEqual({
      target: "path",
      value: null,
    });
  });

  it("copies the branch and thread ID", () => {
    expect(resolveThreadCopy("copy-branch", thread, null)?.value).toBe("feature/x");
    expect(resolveThreadCopy("copy-thread-id", thread, null)?.value).toBe("thread-1");
  });

  it("ignores unrelated events", () => {
    expect(resolveThreadCopy("archive", thread, null)).toBeNull();
  });
});
