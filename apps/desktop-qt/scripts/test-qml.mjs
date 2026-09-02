import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const appDir = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone test launcher has no Effect runtime.
const hostPlatform = process.platform;
const executableName = hostPlatform === "win32" ? "qmltestrunner.exe" : "qmltestrunner";
const testPlatform = process.env.T3_QML_TEST_PLATFORM ?? "offscreen";

function capture(command, args) {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function findRunner() {
  const binDirectories = [
    process.env.QT_ROOT_DIR,
    process.env.QT_PREFIX,
    process.env.CMAKE_PREFIX_PATH,
  ]
    .filter(Boolean)
    .map((prefix) => NodePath.join(prefix, "bin"));
  binDirectories.push(
    capture("qtpaths6", ["--query", "QT_INSTALL_BINS"]),
    capture("qmake6", ["-query", "QT_INSTALL_BINS"]),
  );
  for (const directory of binDirectories) {
    if (!directory) continue;
    const candidate = NodePath.join(directory, executableName);
    if (NodeFS.existsSync(candidate)) return candidate;
  }
  return executableName;
}

const runner = NodeChildProcess.spawnSync(
  findRunner(),
  ["-input", "tests", "-import", "tests/imports"],
  {
    cwd: appDir,
    env: {
      ...process.env,
      QT_QPA_PLATFORM: testPlatform,
      ...(testPlatform === "offscreen" ? { QT_QPA_PLATFORMTHEME: "" } : {}),
    },
    stdio: "inherit",
  },
);
if (runner.error) throw runner.error;
process.exit(runner.status ?? 1);
