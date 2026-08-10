import assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import test from "node:test";

import { createElectronInstallInvocation } from "./ensure-electron-runtime.mjs";

test("Electron repair reuses Electron's own installer without external curl/python", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "electron repair José "));
  const installScript = NodePath.join(root, "install.js");
  NodeFS.writeFileSync(installScript, "// fixture\n");

  try {
    const invocation = createElectronInstallInvocation(root, {
      ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
      ELECTRON_MIRROR: "https://mirror.example.invalid/",
      PATH: process.env.PATH,
    });

    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(invocation.args, [installScript]);
    assert.equal(invocation.cwd, root);
    assert.equal(invocation.env.ELECTRON_SKIP_BINARY_DOWNLOAD, undefined);
    assert.equal(invocation.env.ELECTRON_MIRROR, "https://mirror.example.invalid/");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
