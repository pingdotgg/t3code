import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const require = NodeModule.createRequire(import.meta.url);

// pnpm does not run electron's installer (allowBuilds: electron: false), so the
// binary is fetched here on first launch. install.js reuses ~/.cache/electron.
function electronBinary() {
  const electronDir = NodePath.dirname(require.resolve("electron/package.json"));
  if (!NodeFS.existsSync(NodePath.join(electronDir, "path.txt"))) {
    NodeChildProcess.execFileSync(process.execPath, [NodePath.join(electronDir, "install.js")], {
      stdio: "inherit",
    });
  }
  return require("electron");
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = NodeChildProcess.spawn(electronBinary(), ["dist-electron/electron/main.cjs"], {
  stdio: "inherit",
  env,
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
