import { describe, expect, it } from "vite-plus/test";
import { isAbsoluteWorktreeLocation } from "./ProjectSettingsPanel.logic";

describe("isAbsoluteWorktreeLocation", () => {
  it("accepts the tilde forms the server expands", () => {
    for (const os of ["darwin", "linux", "windows"] as const) {
      expect(isAbsoluteWorktreeLocation("~", os)).toBe(true);
      expect(isAbsoluteWorktreeLocation("~/dev/worktrees", os)).toBe(true);
      expect(isAbsoluteWorktreeLocation("~\\dev\\worktrees", os)).toBe(true);
    }
  });

  it("rejects ~user, which expandHomePath leaves relative", () => {
    expect(isAbsoluteWorktreeLocation("~user/worktrees", "linux")).toBe(false);
    expect(isAbsoluteWorktreeLocation("~foo", "linux")).toBe(false);
  });

  it("rejects relative paths", () => {
    expect(isAbsoluteWorktreeLocation("dev/worktrees", "darwin")).toBe(false);
    expect(isAbsoluteWorktreeLocation("./worktrees", "darwin")).toBe(false);
    expect(isAbsoluteWorktreeLocation("", "darwin")).toBe(false);
  });

  it("accepts POSIX roots on POSIX hosts", () => {
    expect(isAbsoluteWorktreeLocation("/tmp/worktrees", "darwin")).toBe(true);
    expect(isAbsoluteWorktreeLocation("/tmp/worktrees", "linux")).toBe(true);
  });

  it("rejects Windows-shaped roots on POSIX hosts, which the server would reject too", () => {
    expect(isAbsoluteWorktreeLocation("C:\\worktrees", "darwin")).toBe(false);
    expect(isAbsoluteWorktreeLocation("\\\\server\\share", "linux")).toBe(false);
  });

  it("accepts drive letters and UNC shares on Windows hosts", () => {
    expect(isAbsoluteWorktreeLocation("C:\\worktrees", "windows")).toBe(true);
    expect(isAbsoluteWorktreeLocation("C:/worktrees", "windows")).toBe(true);
    expect(isAbsoluteWorktreeLocation("\\\\server\\share\\worktrees", "windows")).toBe(true);
  });

  it("accepts separator-rooted paths on Windows hosts, as path.win32 does", () => {
    expect(isAbsoluteWorktreeLocation("/tmp/worktrees", "windows")).toBe(true);
    expect(isAbsoluteWorktreeLocation("\\worktrees", "windows")).toBe(true);
  });

  it("rejects drive-relative paths, which are not absolute on either host", () => {
    expect(isAbsoluteWorktreeLocation("C:worktrees", "windows")).toBe(false);
    expect(isAbsoluteWorktreeLocation("C:worktrees", "linux")).toBe(false);
  });
});
