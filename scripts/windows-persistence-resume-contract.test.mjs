import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Windows persistence retry policy is centralized and bounded", async () => {
  const [helper, sharedPackage] = await Promise.all([
    read("packages/shared/src/windowsFileRetry.ts"),
    read("packages/shared/package.json"),
  ]);
  assert.match(helper, /WINDOWS_FILE_RETRY_DELAYS/);
  assert.match(helper, /Busy/);
  assert.match(helper, /PermissionDenied/);
  assert.match(helper, /WouldBlock/);
  assert.match(helper, /EPERM/);
  assert.match(helper, /platform !== "win32"/);
  assert.match(sharedPackage, /"\.\/windowsFileRetry"/);
});

test("desktop and server persistence routes through the Windows retry policy", async () => {
  const files = await Promise.all([
    read("apps/desktop/src/settings/DesktopAppSettings.ts"),
    read("apps/desktop/src/settings/DesktopClientSettings.ts"),
    read("apps/desktop/src/settings/DesktopSavedEnvironments.ts"),
    read("apps/desktop/src/app/DesktopConnectionCatalogStore.ts"),
    read("apps/desktop/src/app/DesktopObservability.ts"),
    read("apps/server/src/atomicWrite.ts"),
    read("apps/server/src/auth/ServerSecretStore.ts"),
    read("apps/server/src/serverRuntimeState.ts"),
  ]);
  for (const source of files) {
    assert.match(source, /retryWindowsFileSystemOperation/);
  }
  assert.match(files[4], /fileSystem\.writeFile\(input\.filePath, chunk, \{ flag: "a" \}\)/);
  assert.match(files[5], /fs\.rename\(tempPath, input\.filePath\)/);
});

test("resume recovery probes before restarting and re-resolves WSL state", async () => {
  const [manager, recovery, app, main] = await Promise.all([
    read("apps/desktop/src/backend/DesktopBackendManager.ts"),
    read("apps/desktop/src/app/DesktopPowerRecovery.ts"),
    read("apps/desktop/src/app/DesktopApp.ts"),
    read("apps/desktop/src/main.ts"),
  ]);
  assert.match(manager, /readonly probeReady/);
  assert.match(manager, /waitForHttpReady\(/);
  assert.match(recovery, /onSimpleEvent\("suspend"/);
  assert.match(recovery, /onSimpleEvent\("resume"/);
  assert.match(recovery, /RESUME_SETTLE_DELAY/);
  assert.match(recovery, /generationRef/);
  assert.match(recovery, /recoveryMutex/);
  assert.match(recovery, /instance\.probeReady/);
  assert.match(recovery, /instance\.stop/);
  assert.match(recovery, /instance\.start/);
  assert.match(recovery, /wslBackend\.reconcile/);
  assert.match(recovery, /environment\.platform !== "win32"/);
  assert.match(app, /yield\* electronApp\.whenReady[\s\S]*yield\* powerRecovery\.register/);
  assert.match(main, /DesktopPowerRecovery\.layer/);
});

test("Windows CI exercises a real exclusive file handle", async () => {
  const [ci, lockTest] = await Promise.all([
    read(".github/workflows/ci.yml"),
    read("scripts/windows-persistence-lock.test.mjs"),
  ]);
  assert.match(ci, /windows-persistence-lock\.test\.mjs/);
  assert.match(lockTest, /FileShare\]::None/);
  assert.match(lockTest, /T3-persist|t3-persist/);
  assert.match(lockTest, /attempts > 1/);
});
