import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { stageWslCiNodePty } from "./stage-wsl-ci-node-pty.mjs";

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "t3code-wsl-stage-test-"));
  const serverRoot = path.join(root, "server");
  const runtimeDir = path.join(root, "runtime");
  const nodePtyDir = path.join(serverRoot, "node_modules", "node-pty");
  mkdirSync(nodePtyDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(path.join(serverRoot, "package.json"), '{"name":"fixture","type":"module"}\n');
  writeFileSync(path.join(nodePtyDir, "package.json"), '{"name":"node-pty","version":"1.2.3"}\n');
  const ptyBytes = Buffer.from("fake audited pty bytes\n");
  writeFileSync(path.join(runtimeDir, "pty.node"), ptyBytes);
  const sha256 = createHash("sha256").update(ptyBytes).digest("hex");
  writeFileSync(
    path.join(runtimeDir, "wsl-native-abi.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      baseline: { id: "ubuntu-22.04", limits: { glibc: "2.35" } },
      artifacts: [{ name: "node-pty", sha256 }],
    })}\n`,
  );
  return { serverRoot, runtimeDir, nodePtyDir, sha256 };
}

test("stages the production node-pty marker shape beside the audited binary", () => {
  const fixture = makeFixture();
  const result = stageWslCiNodePty({
    serverRoot: fixture.serverRoot,
    runtimeDir: fixture.runtimeDir,
    arch: "x64",
  });
  const marker = JSON.parse(
    readFileSync(path.join(result.prebuildDir, "t3code-wsl-node-pty.json"), "utf8"),
  );
  assert.deepEqual(marker, {
    arch: "x64",
    nodePtyVersion: "1.2.3",
    sha256: fixture.sha256,
    abiBaseline: "ubuntu-22.04",
    glibcCeiling: "2.35",
  });
  assert.equal(
    readFileSync(path.join(result.prebuildDir, "pty.node"), "utf8"),
    "fake audited pty bytes\n",
  );
});

test("refuses a node-pty artifact whose bytes do not match the ABI receipt", () => {
  const fixture = makeFixture();
  writeFileSync(path.join(fixture.runtimeDir, "pty.node"), "tampered\n");
  assert.throws(
    () =>
      stageWslCiNodePty({
        serverRoot: fixture.serverRoot,
        runtimeDir: fixture.runtimeDir,
        arch: "x64",
      }),
    /artifact hash mismatch/,
  );
});
