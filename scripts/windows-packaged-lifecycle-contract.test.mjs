import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("packaged smoke branches the real Electron main entry", async () => {
  const [main, smoke] = await Promise.all([
    read("apps/desktop/src/main.ts"),
    read("apps/desktop/src/app/DesktopPackagedSmoke.ts"),
  ]);
  assert.match(main, /DesktopPackagedSmoke\.isPackagedSmokeRequested\(\)/);
  assert.match(smoke, /environment\.isPackaged/);
  assert.match(smoke, /primary\.start/);
  assert.match(smoke, /waitForReady/);
  assert.match(smoke, /wslBackend\.retry/);
  assert.match(smoke, /runningDistro/);
  assert.match(smoke, /stopAll/);
  assert.match(smoke, /afterFirstStop/);
  assert.match(smoke, /restartCycle/);
  assert.match(smoke, /activePid/);
});

test("Windows launcher uses hostile path characters and validates shutdown", async () => {
  const script = await read("scripts/run-windows-packaged-lifecycle-smoke.ps1");
  assert.match(script, /T3 Code José QA/);
  assert.match(script, /artifact üñíçødé path/);
  assert.match(script, /state home Ω/);
  assert.match(script, /Assert-ProcessGone/);
  assert.match(script, /Assert-PortBindable/);
  assert.match(script, /TcpClient/);
  assert.match(script, /T3CODE_DESKTOP_PACKAGED_SMOKE_WSL_DISTRO/);
});

test("CI builds and launches a portable packaged artifact after real WSL2 setup", async () => {
  const ci = await read(".github/workflows/ci.yml");
  assert.match(ci, /Windows \+ real WSL2 \+ Packaged Lifecycle/);
  assert.match(ci, /--target portable/);
  assert.match(ci, /--wsl-prebuild/);
  assert.match(ci, /run-windows-packaged-lifecycle-smoke\.ps1/);
  assert.match(ci, /windows-packaged-lifecycle-smoke/);
});
