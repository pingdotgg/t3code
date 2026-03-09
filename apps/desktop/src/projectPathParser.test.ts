import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { normalizePendingProjectPath, resolvePendingProjectPath } from "./projectPathParser";

const TEMP_DIR_PREFIX = "t3-project-path-parser-test-";

describe("resolvePendingProjectPath", () => {
  it("extracts the path from --t3-project-path=<value> format", () => {
    const result = resolvePendingProjectPath([
      "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
      "--t3-project-path=/Users/dev/my-project",
    ]);
    expect(result).toBe("/Users/dev/my-project");
  });

  it("extracts the path from legacy --t3-project-path <value> format", () => {
    const result = resolvePendingProjectPath([
      "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
      "--t3-project-path",
      "/Users/dev/my-project",
    ]);
    expect(result).toBe("/Users/dev/my-project");
  });

  it("ignores interspersed Chromium switches in legacy format", () => {
    const result = resolvePendingProjectPath([
      "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
      "--allow-file-access-from-files",
      "--t3-project-path",
      "--allow-file-access-from-files",
      "--original-process-start-time=12345",
      "/Users/dev/my-project",
    ]);
    expect(result).toBe("/Users/dev/my-project");
  });

  it("is immune to Chromium switch reordering with = format", () => {
    const result = resolvePendingProjectPath([
      "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
      "--allow-file-access-from-files",
      "--original-process-start-time=12345",
      "--t3-project-path=/Users/dev/my-project",
      "--no-sandbox",
    ]);
    expect(result).toBe("/Users/dev/my-project");
  });

  it("returns null when no project path flag is present", () => {
    const result = resolvePendingProjectPath([
      "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
      "--allow-file-access-from-files",
    ]);
    expect(result).toBeNull();
  });

  it("returns null when legacy flag has no non-switch value following it", () => {
    const result = resolvePendingProjectPath([
      "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
      "--t3-project-path",
      "--allow-file-access-from-files",
      "--no-sandbox",
    ]);
    expect(result).toBeNull();
  });

  it("returns null when flag value is empty in = format", () => {
    const result = resolvePendingProjectPath([
      "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
      "--t3-project-path=",
    ]);
    expect(result).toBeNull();
  });

  it("prefers = format over legacy space-separated format", () => {
    const result = resolvePendingProjectPath([
      "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
      "--t3-project-path=/Users/dev/correct-project",
      "--t3-project-path",
      "/Users/dev/wrong-project",
    ]);
    expect(result).toBe("/Users/dev/correct-project");
  });

  it("handles paths with spaces in = format", () => {
    const result = resolvePendingProjectPath([
      "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
      "--t3-project-path=/Users/dev/my project with spaces",
    ]);
    expect(result).toBe("/Users/dev/my project with spaces");
  });
});

describe("normalizePendingProjectPath", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      FS.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("rejects values that start with a dash", () => {
    expect(normalizePendingProjectPath("--allow-file-access-from-files")).toBeNull();
    expect(normalizePendingProjectPath("-v")).toBeNull();
  });

  it("rejects null, undefined, and empty strings", () => {
    expect(normalizePendingProjectPath(null)).toBeNull();
    expect(normalizePendingProjectPath(undefined)).toBeNull();
    expect(normalizePendingProjectPath("")).toBeNull();
    expect(normalizePendingProjectPath("   ")).toBeNull();
  });

  it("resolves absolute paths as-is", () => {
    expect(normalizePendingProjectPath("/Users/dev/my-project")).toBe("/Users/dev/my-project");
  });

  it("canonicalizes existing paths via realpathSync.native", () => {
    tempDir = FS.mkdtempSync(Path.join(OS.tmpdir(), TEMP_DIR_PREFIX));
    const realDir = Path.join(tempDir, "RealDir");
    FS.mkdirSync(realDir);

    const result = normalizePendingProjectPath(realDir);
    expect(result).toBe(FS.realpathSync.native(realDir));
  });

  it("returns Path.resolve for non-existent paths", () => {
    const fakePath = "/definitely/does/not/exist/t3-test-" + Date.now();
    const result = normalizePendingProjectPath(fakePath);
    expect(result).toBe(Path.resolve(fakePath));
  });
});
