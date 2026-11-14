// Proves agent preview tabs still paint while the app window is hidden or minimized,
// using the window options the preview manager ships. Unit tests mock Electron.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const RUN_TIMEOUT_MS = 90_000;
const entry = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "verify-background-preview.electron.cjs",
);
// The plain binary: the development launcher's renamed app bundle refuses data: URLs.
const electronPath = NodeModule.createRequire(import.meta.url)("electron");
const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
// Only a run that finished every capture writes this, so an early clean quit still fails.
const done = NodePath.join(
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-background-preview-")),
  "done",
);
const child = NodeChildProcess.spawn(electronPath, [entry], {
  stdio: "inherit",
  env: { ...env, T3_BACKGROUND_PREVIEW_DONE: done },
});
const timer = setTimeout(() => {
  console.error(`Background preview check did not finish within ${RUN_TIMEOUT_MS}ms.`);
  child.kill("SIGKILL");
}, RUN_TIMEOUT_MS);
child.on("exit", (code, signal) => {
  clearTimeout(timer);
  if (code === 0 && !NodeFS.existsSync(done)) {
    console.error("Background preview check quit before it finished.");
    process.exit(1);
  }
  process.exit(code ?? (signal ? 1 : 0));
});
