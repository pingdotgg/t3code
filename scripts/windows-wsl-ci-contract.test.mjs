import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const bootstrap = readFileSync(new URL("./bootstrap-wsl2-ci.ps1", import.meta.url), "utf8");
const smoke = readFileSync(new URL("./smoke-wsl2-native-runtime.ps1", import.meta.url), "utf8");
const integration = readFileSync(
  new URL("../apps/desktop/src/wsl/DesktopWslEnvironment.windows.integration.test.ts", import.meta.url),
  "utf8",
);
const stage = readFileSync(new URL("./stage-wsl-ci-node-pty.mjs", import.meta.url), "utf8");

test("CI has merge-gatable native Windows and real WSL2 jobs", () => {
  assert.match(ci, /\n  windows_native:\n/);
  assert.match(ci, /\n  windows_wsl2_integration:\n/);
  assert.match(ci, /runs-on: windows-2025/);
  assert.match(ci, /vp run --filter @t3tools\/desktop test/);
  assert.match(ci, /vp run build:desktop/);
  assert.match(ci, /DesktopWslEnvironment\.windows\.integration\.test\.ts/);
});

test("WSL2 integration reuses an ABI-audited runtime and two real distros", () => {
  assert.match(ci, /\n  wsl_native_ci:\n/);
  assert.match(ci, /image: ubuntu:22\.04/);
  assert.match(ci, /--max-glibc 2\.35/);
  assert.match(ci, /ci-wsl-native-runtime-x64/);
  assert.match(ci, /stage-wsl-ci-node-pty\.mjs --server-root apps\/server/);
  assert.match(ci, /bootstrap-wsl2-ci\.ps1 -Distros Ubuntu-24\.04,Debian/);
  assert.match(ci, /smoke-wsl2-native-runtime\.ps1 -RuntimeDir \.\/wsl-prebuild -Distros Ubuntu-24\.04,Debian/);
});

test("WSL bootstrap enforces WSL2 and deliberately changes the default distro", () => {
  assert.match(bootstrap, /--set-default-version", "2"/);
  assert.match(bootstrap, /--set-version", \$distro, "2"/);
  assert.match(bootstrap, /--set-default", \$Distros\[1\]/);
  assert.match(bootstrap, /useradd -m -s \/bin\/bash t3ci/);
  assert.match(bootstrap, /default=t3ci/);
  assert.match(bootstrap, /T3CODE_WSL_EXPECTED_DEFAULT_DISTRO/);
});

test("real WSL integration gates the repaired production boundaries", () => {
  assert.match(integration, /environment\.probeDistros/);
  assert.match(integration, /environment\.windowsToWslPath/);
  assert.match(integration, /environment\.ensureNodePty/);
  assert.match(stage, /t3code-wsl-node-pty\.json/);
  assert.match(stage, /nodePtyVersion/);
  assert.match(stage, /abiBaseline/);
  assert.match(integration, /printf corrupted/);
  assert.match(integration, /environment\.allocateTcpPort/);
  assert.match(integration, /EADDRINUSE/);
  assert.match(integration, /fetchHealth/);
});

test("native smoke executes the audited Node and Linux-native modules inside WSL", () => {
  assert.match(smoke, /smoke-wsl-native-runtime\.mjs/);
  assert.match(smoke, /--node-runtime/);
  assert.match(smoke, /--node-pty/);
  assert.match(smoke, /--manifest/);
  assert.match(smoke, /chmod 0755/);
});
