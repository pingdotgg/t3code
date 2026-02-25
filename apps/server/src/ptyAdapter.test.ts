import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, it, vi } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach } from "vitest";

import { ensureNodePtySpawnHelperExecutable } from "./ptyAdapter";

function fileMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const helperLayer = it.layer(Layer.empty);

helperLayer("ensureNodePtySpawnHelperExecutable", (it) => {
  it.effect("adds executable bits when helper exists but is not executable", () =>
    Effect.sync(() => {
      if (process.platform === "win32") return;

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pty-helper-test-"));
      tempDirs.push(dir);
      const helperPath = path.join(dir, "spawn-helper");
      fs.writeFileSync(helperPath, "#!/bin/sh\nexit 0\n", "utf8");
      fs.chmodSync(helperPath, 0o644);

      ensureNodePtySpawnHelperExecutable(helperPath);

      assert.equal(fileMode(helperPath) & 0o111, 0o111);
    }),
  );

  it.effect("keeps executable helper as executable", () =>
    Effect.sync(() => {
      if (process.platform === "win32") return;

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pty-helper-test-"));
      tempDirs.push(dir);
      const helperPath = path.join(dir, "spawn-helper");
      fs.writeFileSync(helperPath, "#!/bin/sh\nexit 0\n", "utf8");
      fs.chmodSync(helperPath, 0o755);

      ensureNodePtySpawnHelperExecutable(helperPath);

      assert.equal(fileMode(helperPath) & 0o111, 0o111);
    }),
  );

  it.effect("does not throw when helper path is missing", () =>
    Effect.sync(() => {
      const missing = path.join(os.tmpdir(), `does-not-exist-${Date.now()}`);
      ensureNodePtySpawnHelperExecutable(missing);
    }),
  );
});
