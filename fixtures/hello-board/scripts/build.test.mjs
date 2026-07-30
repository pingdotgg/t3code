import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

const fixtureRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const buildScript = NodePath.join(fixtureRoot, "scripts", "build.mjs");

function runBuild(args) {
  return NodeChildProcess.spawnSync(process.execPath, [buildScript, ...args], {
    cwd: fixtureRoot,
    encoding: "utf8",
  });
}

for (const [name, args] of [
  ["empty equals form", ["--out-dir="]],
  ["empty next arg", ["--out-dir", ""]],
  ["fixture root", ["--out-dir", "."]],
  ["parent traversal", ["--out-dir", ".."]],
]) {
  NodeTest.test(`rejects unsafe --out-dir: ${name}`, () => {
    const outsideSentinel = NodePath.join(fixtureRoot, "..", ".hello-board-build-sentinel");
    NodeFS.writeFileSync(outsideSentinel, "keep");
    try {
      const result = runBuild(args);
      NodeAssert.notEqual(result.status, 0);
      NodeAssert.match(`${result.stderr}\n${result.stdout}`, /--out-dir/);
      NodeAssert.equal(NodeFS.readFileSync(outsideSentinel, "utf8"), "keep");
    } finally {
      NodeFS.rmSync(outsideSentinel, { force: true });
    }
  });
}
