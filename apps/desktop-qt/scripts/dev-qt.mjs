/**
 * Dev loop for the Qt shell:
 *   1. configure + build apps/desktop-qt with CMake (incremental after the first run)
 *   2. find the dev server started by `vp run dev` and mint a pairing URL for it
 *   3. launch t3code-qt --url <pairing url>
 *
 * Flags:
 *   --configure-only   stop after the CMake build
 *   --url <url>        skip pairing and load this URL
 *   --release          build with CMAKE_BUILD_TYPE=Release (no disk QML loading)
 * Environment:
 *   QT_PREFIX / CMAKE_PREFIX_PATH   where Qt 6 lives (defaults: qmake6 on PATH, then Homebrew)
 *   T3CODE_HOME                     data dir of the dev server to pair with (same as `vp run dev --home-dir`)
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { findPairingUrl } from "../host/pairingUrl.ts";

const appDir = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const serverBin = NodePath.resolve(appDir, "../server/src/bin.ts");

const args = process.argv.slice(2);
const configureOnly = args.includes("--configure-only");
const release = args.includes("--release");
const urlIndex = args.indexOf("--url");
const explicitUrl = urlIndex >= 0 ? args[urlIndex + 1] : undefined;
const buildType = release ? "Release" : "Debug";
const buildDir = NodePath.join(appDir, "build", buildType.toLowerCase());

function fail(message) {
  process.stderr.write(`[dev-qt] ${message}\n`);
  process.exit(1);
}

function run(command, commandArgs) {
  const result = NodeChildProcess.spawnSync(command, commandArgs, {
    cwd: appDir,
    stdio: "inherit",
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0)
    fail(`${command} ${commandArgs.join(" ")} exited with ${String(result.status)}`);
}

function capture(command, commandArgs) {
  const result = NodeChildProcess.spawnSync(command, commandArgs, { encoding: "utf8" });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.trim();
}

function resolveQtPrefix() {
  const fromEnv = process.env.QT_PREFIX ?? process.env.CMAKE_PREFIX_PATH;
  if (fromEnv) return fromEnv;
  const fromQmake =
    capture("qmake6", ["-query", "QT_INSTALL_PREFIX"]) ??
    capture("qmake", ["-query", "QT_INSTALL_PREFIX"]);
  if (fromQmake) return fromQmake;
  const fromBrew = capture("brew", ["--prefix", "qt"]);
  if (fromBrew) return fromBrew;
  return fail(
    "Qt 6 not found. Set QT_PREFIX to the Qt install (e.g. /opt/homebrew/opt/qt or ~/Qt/6.11.1/gcc_64).",
  );
}

function build() {
  if (!NodeFS.existsSync(NodePath.join(buildDir, "CMakeCache.txt"))) {
    const qtPrefix = resolveQtPrefix();
    process.stderr.write(`[dev-qt] configuring (${buildType}) with Qt at ${qtPrefix}\n`);
    run("cmake", [
      "-S",
      appDir,
      "-B",
      buildDir,
      "-G",
      "Ninja",
      `-DCMAKE_BUILD_TYPE=${buildType}`,
      `-DCMAKE_PREFIX_PATH=${qtPrefix}`,
    ]);
  }
  run("cmake", ["--build", buildDir]);
}

function binaryPath() {
  // macOS bundle, plain executable, Windows executable: whichever this build produced.
  const candidates = [
    NodePath.join(buildDir, "t3code-qt.app/Contents/MacOS/t3code-qt"),
    NodePath.join(buildDir, "t3code-qt"),
    NodePath.join(buildDir, "t3code-qt.exe"),
  ];
  const found = candidates.find((candidate) => NodeFS.existsSync(candidate));
  return found ?? fail(`built binary not found under ${buildDir}`);
}

function pairWithDevServer() {
  const result = NodeChildProcess.spawnSync(process.execPath, [serverBin, "pair"], {
    cwd: appDir,
    encoding: "utf8",
  });
  const url = findPairingUrl(`${result.stdout}\n${result.stderr}`);
  if (url !== undefined) return url;
  // `pair` logs its "No running T3 Code server" report (with the state paths it
  // checked) through the Effect logger, i.e. on stdout.
  process.stderr.write(`${result.stdout}${result.stderr}`.trim() + "\n");
  return fail(
    "no running dev server to attach to. Start `vp run dev` in another terminal first (same T3CODE_HOME), or pass --url <pairing url>.",
  );
}

build();
if (configureOnly) process.exit(0);

const url = explicitUrl ?? pairWithDevServer();
const binary = binaryPath();
process.stderr.write(`[dev-qt] launching ${binary} --url ${url}\n`);
const child = NodeChildProcess.spawn(binary, ["--url", url], { stdio: "inherit", cwd: appDir });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => process.exit(code ?? 0));
