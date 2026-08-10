import assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(
  NodeFS.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const electronRepair = NodeFS.readFileSync(
  new URL("../apps/desktop/scripts/ensure-electron-runtime.mjs", import.meta.url),
  "utf8",
);
const devElectron = NodeFS.readFileSync(
  new URL("../apps/desktop/scripts/dev-electron.mjs", import.meta.url),
  "utf8",
);
const processTree = NodeFS.readFileSync(
  new URL("../apps/desktop/scripts/windows-process-tree.mjs", import.meta.url),
  "utf8",
);
const ci = NodeFS.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const terminalDocs = NodeFS.readFileSync(
  new URL("../docs/architecture/terminal-renderers.md", import.meta.url),
  "utf8",
);

test("root clean is a Node-owned cross-platform command", () => {
  assert.equal(packageJson.scripts.clean, "node scripts/clean.mjs");
});

test("Electron repair no longer depends on curl, python3, or a hand-built file URL", () => {
  assert.doesNotMatch(electronRepair, /runChecked\(["']curl["']/);
  assert.doesNotMatch(electronRepair, /runChecked\(["']python3["']/);
  assert.doesNotMatch(electronRepair, /file:\/\/\$\{process\.argv/);
  assert.match(electronRepair, /install\.js/);
  assert.match(electronRepair, /process\.execPath/);
});

test("Windows dev shutdown owns the Electron descendant tree", () => {
  assert.match(devElectron, /terminateWindowsProcessTree/);
  assert.match(processTree, /taskkill\.exe/);
  assert.match(processTree, /"\/T"/);
  assert.match(processTree, /"\/F"/);
});

test("Windows CI executes shared shell semantics and developer-tool tests", () => {
  assert.match(ci, /Test shared Windows shell semantics/);
  assert.match(ci, /--filter @t3tools\/shared test/);
  assert.match(ci, /Test Windows developer tooling/);
  assert.match(ci, /windows-process-tree\.test\.mjs/);
});

test(
  "exposed Windows arm64 packaging is explicitly Windows-only until arm64 WSL assets exist",
  () => {
    assert.match(packageJson.scripts["dist:desktop:win:arm64"], /--without-wsl/);
  },
);

test("optional Ghostty regeneration documents its Windows WSL/POSIX requirement", () => {
  assert.match(terminalDocs, /not part of the normal build or\s+test pipeline/);
  assert.match(terminalDocs, /run it from WSL/);
});
