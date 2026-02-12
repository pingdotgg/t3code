import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureNodePtySpawnHelperExecutable } from "./ptyAdapter";

function fileMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

describe("ensureNodePtySpawnHelperExecutable", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds executable bits when helper exists but is not executable", () => {
    if (process.platform === "win32") return;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pty-helper-test-"));
    tempDirs.push(dir);
    const helperPath = path.join(dir, "spawn-helper");
    fs.writeFileSync(helperPath, "#!/bin/sh\nexit 0\n", "utf8");
    fs.chmodSync(helperPath, 0o644);

    ensureNodePtySpawnHelperExecutable(helperPath);

    expect(fileMode(helperPath) & 0o111).toBe(0o111);
  });

  it("keeps executable helper as executable", () => {
    if (process.platform === "win32") return;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pty-helper-test-"));
    tempDirs.push(dir);
    const helperPath = path.join(dir, "spawn-helper");
    fs.writeFileSync(helperPath, "#!/bin/sh\nexit 0\n", "utf8");
    fs.chmodSync(helperPath, 0o755);

    ensureNodePtySpawnHelperExecutable(helperPath);

    expect(fileMode(helperPath) & 0o111).toBe(0o111);
  });

  it("does not throw when helper path is missing", () => {
    const missing = path.join(os.tmpdir(), `does-not-exist-${Date.now()}`);
    expect(() => ensureNodePtySpawnHelperExecutable(missing)).not.toThrow();
  });
});
