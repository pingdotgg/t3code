import { describe, expect, it } from "@effect/vitest";

import {
  canResolveComposerHostFilePaths,
  composerMentionPathFromAbsolute,
  hostPathUsableOnPlatform,
  partitionDroppedComposerFiles,
  workspaceRelativeDropPath,
} from "./composerFileDrop.ts";

const file = (name: string, type: string) => ({ name, type });

describe("canResolveComposerHostFilePaths", () => {
  it("allows only the primary same-host environment", () => {
    expect(canResolveComposerHostFilePaths("PrimaryConnectionTarget")).toBe(true);
    expect(canResolveComposerHostFilePaths("BearerConnectionTarget")).toBe(false);
    expect(canResolveComposerHostFilePaths("SshConnectionTarget")).toBe(false);
    expect(canResolveComposerHostFilePaths("RelayConnectionTarget")).toBe(false);
    expect(canResolveComposerHostFilePaths(null)).toBe(false);
  });
});

describe("hostPathUsableOnPlatform", () => {
  it("rejects Windows renderer paths for a POSIX environment (WSL-only mode)", () => {
    expect(hostPathUsableOnPlatform("C:\\Users\\me\\file.txt", "linux")).toBe(false);
    expect(hostPathUsableOnPlatform("\\\\wsl$\\Ubuntu\\home\\me\\file.txt", "linux")).toBe(false);
  });

  it("accepts paths whose style matches the environment", () => {
    expect(hostPathUsableOnPlatform("C:\\Users\\me\\file.txt", "windows")).toBe(true);
    expect(hostPathUsableOnPlatform("/Users/me/file.txt", "darwin")).toBe(true);
    expect(hostPathUsableOnPlatform("/home/me/file.txt", "linux")).toBe(true);
  });

  it("rejects POSIX paths for a Windows environment", () => {
    expect(hostPathUsableOnPlatform("/home/me/file.txt", "windows")).toBe(false);
  });

  it("allows unknown platforms to preserve behavior", () => {
    expect(hostPathUsableOnPlatform("C:\\Users\\me\\file.txt", "unknown")).toBe(true);
    expect(hostPathUsableOnPlatform("/home/me/file.txt", null)).toBe(true);
  });
});

describe("workspaceRelativeDropPath", () => {
  it("relativizes a path inside the workspace", () => {
    expect(workspaceRelativeDropPath("/Users/me/repo/src/app.ts", "/Users/me/repo")).toBe(
      "src/app.ts",
    );
  });

  it("ignores Windows path casing and trailing separators", () => {
    expect(
      workspaceRelativeDropPath("C:\\Users\\Me\\Repo\\notes.txt", "c:\\users\\me\\repo\\"),
    ).toBe("notes.txt");
  });

  it("preserves case when comparing POSIX paths", () => {
    expect(
      workspaceRelativeDropPath("/home/alice/repo/secrets.txt", "/home/alice/Repo"),
    ).toBeNull();
  });

  it("normalizes Windows separators", () => {
    expect(workspaceRelativeDropPath("C:\\repo\\logs\\app.log", "C:\\repo")).toBe("logs/app.log");
  });

  it("returns null for paths outside the workspace", () => {
    expect(workspaceRelativeDropPath("/tmp/other.log", "/Users/me/repo")).toBeNull();
  });

  it("refuses prefix matches that are not directory boundaries", () => {
    expect(workspaceRelativeDropPath("/Users/me/repo-copy/a.txt", "/Users/me/repo")).toBeNull();
  });

  it("returns null without a workspace root", () => {
    expect(workspaceRelativeDropPath("/Users/me/repo/a.txt", null)).toBeNull();
  });

  it("preserves backslashes in POSIX filenames", () => {
    expect(workspaceRelativeDropPath("/Users/me/repo/a\\b.txt", "/Users/me/repo")).toBe("a\\b.txt");
  });

  it("relativizes against a filesystem-root workspace", () => {
    expect(workspaceRelativeDropPath("/var/log/app.log", "/")).toBe("var/log/app.log");
    expect(workspaceRelativeDropPath("/", "/")).toBeNull();
  });

  it("returns null for an empty workspace root", () => {
    expect(workspaceRelativeDropPath("/var/log/app.log", "")).toBeNull();
  });

  it("keeps the slice aligned when lowercasing changes string length", () => {
    // "İ" (U+0130) lowercases to a two-code-point sequence.
    expect(workspaceRelativeDropPath("C:\\İstanbul\\a.txt", "C:\\İstanbul")).toBe("a.txt");
  });
});

describe("composerMentionPathFromAbsolute", () => {
  it("prefers the workspace-relative path", () => {
    expect(composerMentionPathFromAbsolute("/Users/me/repo/src/app.ts", "/Users/me/repo")).toBe(
      "src/app.ts",
    );
  });

  it("falls back to the normalized absolute path", () => {
    expect(composerMentionPathFromAbsolute("C:\\other\\notes.txt", "/Users/me/repo")).toBe(
      "C:/other/notes.txt",
    );
  });

  it("preserves backslashes in POSIX paths outside the workspace", () => {
    expect(composerMentionPathFromAbsolute("/tmp/a\\b.txt", "/Users/me/repo")).toBe(
      "/tmp/a\\b.txt",
    );
  });
});

describe("partitionDroppedComposerFiles", () => {
  it("routes images to the attachment flow untouched", () => {
    const image = file("shot.png", "image/png");
    const result = partitionDroppedComposerFiles([image], () => null, null);
    expect(result.imageFiles).toEqual([image]);
    expect(result.mentionText).toBeNull();
    expect(result.unresolvedFileNames).toEqual([]);
  });

  it("turns a non-image file with a workspace path into a relative mention", () => {
    const result = partitionDroppedComposerFiles(
      [file("app.log", "text/plain")],
      () => "/Users/me/repo/logs/app.log",
      "/Users/me/repo",
    );
    expect(result.mentionText).toBe("[app.log](logs/app.log) ");
    expect(result.imageFiles).toEqual([]);
    expect(result.unresolvedFileNames).toEqual([]);
  });

  it("keeps the absolute path for files outside the workspace", () => {
    const result = partitionDroppedComposerFiles(
      [file("test.mp3", "audio/mpeg")],
      () => "/Users/me/Downloads/test.mp3",
      "/Users/me/repo",
    );
    expect(result.mentionText).toBe("[test.mp3](/Users/me/Downloads/test.mp3) ");
  });

  it("handles directories, which carry an empty MIME type", () => {
    const result = partitionDroppedComposerFiles(
      [file("fixtures", "")],
      () => "/Users/me/repo/test/fixtures",
      "/Users/me/repo",
    );
    expect(result.mentionText).toBe("[fixtures](test/fixtures) ");
  });

  it("splits a mixed drop between attachments and mentions", () => {
    const image = file("shot.png", "image/png");
    const result = partitionDroppedComposerFiles(
      [image, file("data.csv", "text/csv")],
      () => "/Users/me/repo/data.csv",
      "/Users/me/repo",
    );
    expect(result.imageFiles).toEqual([image]);
    expect(result.mentionText).toBe("[data.csv](data.csv) ");
  });

  it("joins multiple mentions into a single insert", () => {
    const paths: Record<string, string> = {
      "a.log": "/repo/a.log",
      "b.log": "/repo/b.log",
    };
    const result = partitionDroppedComposerFiles(
      [file("a.log", "text/plain"), file("b.log", "text/plain")],
      (dropped) => paths[dropped.name] ?? null,
      "/repo",
    );
    expect(result.mentionText).toBe("[a.log](a.log) [b.log](b.log) ");
  });

  it("reports non-image files without a resolvable path", () => {
    const result = partitionDroppedComposerFiles(
      [file("test.mp3", "audio/mpeg")],
      () => null,
      "/Users/me/repo",
    );
    expect(result.mentionText).toBeNull();
    expect(result.unresolvedFileNames).toEqual(["test.mp3"]);
  });

  it("encodes paths with spaces as valid mention links", () => {
    const result = partitionDroppedComposerFiles(
      [file("my notes.txt", "text/plain")],
      () => "/Users/me/repo/docs/my notes.txt",
      "/Users/me/repo",
    );
    expect(result.mentionText).toBe("[my notes.txt](docs/my%20notes.txt) ");
  });
});
