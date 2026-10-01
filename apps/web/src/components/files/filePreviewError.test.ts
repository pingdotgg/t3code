import { ProjectReadFileError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { detectDuplicatedWorkspacePrefix, getFilePreviewErrorDetails } from "./filePreviewError";

describe("detectDuplicatedWorkspacePrefix", () => {
  it("detects duplicated workspace folder in POSIX paths", () => {
    expect(
      detectDuplicatedWorkspacePrefix("/Users/user/CMU/33120", "33120/film-critique/outline.md"),
    ).toBe("33120");

    expect(detectDuplicatedWorkspacePrefix("/home/dev/repo", "repo/src/index.ts")).toBe("repo");
  });

  it("detects duplicated workspace folder in Windows paths", () => {
    expect(detectDuplicatedWorkspacePrefix("C:\\Projects\\my-app", "my-app\\src\\index.ts")).toBe(
      "my-app",
    );

    expect(detectDuplicatedWorkspacePrefix("C:/Projects/my-app", "my-app/src/index.ts")).toBe(
      "my-app",
    );
  });

  it("returns null when relative path does not duplicate workspace folder", () => {
    expect(
      detectDuplicatedWorkspacePrefix("/Users/user/CMU/33120", "film-critique/outline.md"),
    ).toBeNull();

    expect(detectDuplicatedWorkspacePrefix("C:\\Projects\\my-app", "src\\index.ts")).toBeNull();
  });

  it("returns null for single-segment paths matching the folder name exactly", () => {
    expect(detectDuplicatedWorkspacePrefix("/Users/user/CMU/33120", "33120")).toBeNull();
  });

  it("returns null for empty or invalid paths", () => {
    expect(detectDuplicatedWorkspacePrefix("", "test.ts")).toBeNull();
    expect(detectDuplicatedWorkspacePrefix("/repo", "")).toBeNull();
    expect(detectDuplicatedWorkspacePrefix(null, null)).toBeNull();
  });
});

describe("getFilePreviewErrorDetails", () => {
  it("formats path_not_file error correctly", () => {
    const error = new ProjectReadFileError({
      cwd: "/repo",
      relativePath: "assets",
      failure: "path_not_file",
      resolvedPath: "/repo/assets",
    });

    const details = getFilePreviewErrorDetails({
      cwd: "/repo",
      relativePath: "assets",
      readError: error,
    });

    expect(details.title).toBe("Not a regular file");
    expect(details.explanation).toBe(
      "The path is a directory or special file, not a regular file.",
    );
    expect(details.attemptedPath).toBe("/repo/assets");
    expect(details.duplicateWorkspacePrefixHint).toBeNull();
  });

  it("formats binary_file error correctly", () => {
    const error = new ProjectReadFileError({
      cwd: "/repo",
      relativePath: "binary.bin",
      failure: "binary_file",
      operationPath: "/repo/binary.bin",
    });

    const details = getFilePreviewErrorDetails({
      cwd: "/repo",
      relativePath: "binary.bin",
      readError: error,
    });

    expect(details.title).toBe("Binary file");
    expect(details.explanation).toBe("The file is binary and cannot be displayed in text preview.");
    expect(details.attemptedPath).toBe("/repo/binary.bin");
  });

  it("formats workspace_path_outside_root error correctly", () => {
    const error = new ProjectReadFileError({
      cwd: "/repo",
      relativePath: "../outside.txt",
      failure: "workspace_path_outside_root",
      resolvedPath: "/outside.txt",
    });

    const details = getFilePreviewErrorDetails({
      cwd: "/repo",
      relativePath: "../outside.txt",
      readError: error,
    });

    expect(details.title).toBe("Path outside workspace");
    expect(details.explanation).toBe("The requested path is outside the workspace root directory.");
    expect(details.attemptedPath).toBe("/outside.txt");
  });

  it("formats resolved_path_outside_root error correctly", () => {
    const error = new ProjectReadFileError({
      cwd: "/repo",
      relativePath: "symlink-outside",
      failure: "resolved_path_outside_root",
      resolvedPath: "/etc/passwd",
    });

    const details = getFilePreviewErrorDetails({
      cwd: "/repo",
      relativePath: "symlink-outside",
      readError: error,
    });

    expect(details.title).toBe("Resolved path outside workspace");
    expect(details.explanation).toBe(
      "The path resolves to a location outside the workspace root directory.",
    );
    expect(details.attemptedPath).toBe("/etc/passwd");
  });

  it("formats operation_failed error without claiming file not found", () => {
    const error = new ProjectReadFileError({
      cwd: "/Users/user/CMU/33120",
      relativePath: "33120/film-critique/outline.md",
      failure: "operation_failed",
      operation: "realpath-target",
      resolvedPath: "/Users/user/CMU/33120/33120/film-critique/outline.md",
      operationPath: "/Users/user/CMU/33120/33120/film-critique/outline.md",
    });

    const details = getFilePreviewErrorDetails({
      cwd: "/Users/user/CMU/33120",
      relativePath: "33120/film-critique/outline.md",
      readError: error,
    });

    expect(details.title).toBe("Failed to read file");
    expect(details.explanation).toBe("The file could not be accessed or read.");
    expect(details.attemptedPath).toBe("/Users/user/CMU/33120/33120/film-critique/outline.md");
    expect(details.duplicateWorkspacePrefixHint).toBe(
      'The path begins with "33120", which matches the workspace folder name. The link may have mistakenly included the workspace folder in its relative path.',
    );
  });

  it("formats fallback error when readError is null", () => {
    const details = getFilePreviewErrorDetails({
      cwd: "/repo",
      relativePath: "missing.ts",
      readError: null,
      fallbackError: "Network connection lost",
    });

    expect(details.title).toBe("Failed to read file");
    expect(details.explanation).toBe("Network connection lost");
    expect(details.attemptedPath).toBeNull();
  });
});
