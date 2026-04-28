import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isGitRepository } from "./Utils";

const tempDirs: string[] = [];

function makeTempDir() {
  const directory = mkdtempSync(join(tmpdir(), "t3-git-utils-"));
  tempDirs.push(directory);
  return directory;
}

function initGitRepository(root: string) {
  execFileSync("git", ["init"], {
    cwd: root,
    stdio: "ignore",
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (!directory) {
      continue;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("isGitRepository", () => {
  it("returns true for a git repository root", () => {
    const root = makeTempDir();
    initGitRepository(root);

    expect(isGitRepository(root)).toBe(true);
  });

  it("returns true for nested directories inside a git repository", () => {
    const root = makeTempDir();
    initGitRepository(root);
    const nestedDirectory = join(root, "apps", "server");
    mkdirSync(nestedDirectory, { recursive: true });

    expect(isGitRepository(nestedDirectory)).toBe(true);
  });

  it("returns false outside a git repository", () => {
    const directory = makeTempDir();

    expect(isGitRepository(directory)).toBe(false);
  });
});
