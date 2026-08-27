/**
 * Dev loop for the Qt shell:
 *   1. configure + build apps/desktop-qt with CMake (incremental after the first run)
 *   2. find the dev server started by `vp run dev` and mint a pairing URL for it
 *   3. launch t3code-qt --url <pairing url>
 *
 * Flags the script consumes:
 *   --home-dir <dir>   T3 Code data directory of the dev server to pair with (same
 *                      as `vp run dev --home-dir`). Also becomes the shell's
 *                      T3CODE_HOME so it rices from <dir>/shell. Defaults to the
 *                      worktree's own .t3, then T3CODE_HOME, then ~/.t3 — the
 *                      precedence `vp run dev` and `t3 pair` use.
 *   --url <url>        skip pairing and load this URL
 *   --release          build with CMAKE_BUILD_TYPE=Release (no disk QML loading)
 *   --configure-only   stop after the CMake build
 *   --help
 * Every other argument is passed through to the t3code-qt binary, so the
 * shell's own flags (--config-dir, --qml-dir, --screenshot, --action, ...)
 * work from `vp run dev:qt` too. A bare `--` forwards the rest verbatim.
 * Environment:
 *   QT_PREFIX / CMAKE_PREFIX_PATH   where Qt 6 lives (defaults: qmake6 on PATH, then Homebrew)
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { findPairingUrl } from "../host/pairingUrl.ts";

const appDir = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const serverBin = NodePath.resolve(appDir, "../server/src/bin.ts");

function fail(message) {
  process.stderr.write(`[dev-qt] ${message}\n`);
  process.exit(1);
}

function usage() {
  process.stdout.write(
    [
      "Usage: vp run dev:qt [--home-dir <dir>] [--url <url>] [--release] [--configure-only] [-- <t3code-qt args>]",
      "",
      "  --home-dir <dir>   data directory of the dev server to pair with (as `vp run dev --home-dir`)",
      "  --url <url>        skip pairing and load this URL",
      "  --release          Release build (no disk QML loading)",
      "  --configure-only   build, do not launch",
      "",
      "Anything else is forwarded to t3code-qt (--config-dir, --qml-dir, --screenshot, --action, ...).",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const options = { configureOnly: false, release: false, url: undefined, homeDir: undefined };
  const shellArgs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const takeValue = () => {
      const value = argv[index + 1];
      if (value === undefined) fail(`${arg} needs a value`);
      index += 1;
      return value;
    };
    if (arg === "--") {
      shellArgs.push(...argv.slice(index + 1));
      break;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg === "--configure-only") {
      options.configureOnly = true;
    } else if (arg === "--release") {
      options.release = true;
    } else if (arg === "--url") {
      options.url = takeValue();
    } else if (arg.startsWith("--url=")) {
      options.url = arg.slice("--url=".length);
    } else if (arg === "--home-dir") {
      options.homeDir = takeValue();
    } else if (arg.startsWith("--home-dir=")) {
      options.homeDir = arg.slice("--home-dir=".length);
    } else {
      shellArgs.push(arg);
    }
  }
  return { options, shellArgs };
}

const { options, shellArgs } = parseArgs(process.argv.slice(2));
const buildType = options.release ? "Release" : "Debug";
const buildDir = NodePath.join(appDir, "build", buildType.toLowerCase());

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

function expandHome(raw) {
  const trimmed = raw.trim();
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    return NodePath.join(NodeOS.homedir(), trimmed.slice(1));
  }
  return trimmed;
}

/**
 * The worktree-local `.t3` when this checkout is a linked git worktree, else
 * undefined. Mirrors `resolveWorktreeT3Home` in packages/shared/devHome:
 * git puts a linked worktree's git dir at `<common-dir>/worktrees/<name>`.
 */
function resolveWorktreeHome() {
  const gitDir = capture("git", ["-C", appDir, "rev-parse", "--absolute-git-dir"]);
  const topLevel = capture("git", ["-C", appDir, "rev-parse", "--show-toplevel"]);
  if (gitDir === undefined || topLevel === undefined) return undefined;
  const segments = gitDir.split(/[/\\]/).filter((segment) => segment.length > 0);
  const isLinkedWorktree = segments.length >= 3 && segments.at(-2) === "worktrees";
  return isLinkedWorktree ? NodePath.join(topLevel, ".t3") : undefined;
}

/** `--home-dir` > worktree `.t3` > `T3CODE_HOME` > `~/.t3`, as `vp run dev` and `t3 pair` resolve it. */
function resolveHomeDir() {
  const explicit = options.homeDir ?? "";
  if (explicit.trim().length > 0) return NodePath.resolve(expandHome(explicit));
  const worktreeHome = resolveWorktreeHome();
  if (worktreeHome !== undefined) return worktreeHome;
  const fromEnv = process.env.T3CODE_HOME ?? "";
  if (fromEnv.trim().length > 0) return NodePath.resolve(expandHome(fromEnv));
  const shared = NodePath.join(NodeOS.homedir(), ".t3");
  refuseLiveInstall(shared);
  return shared;
}

/**
 * `pair --base-dir ~/.t3` probes `userdata` (the installed app's database)
 * before `dev` (what a plain-checkout `vp run dev` serves). Pairing must never
 * mint a token into the live install, so bail out while that app is running.
 */
function refuseLiveInstall(sharedHome) {
  const userdata = NodePath.join(sharedHome, "userdata");
  let pid;
  try {
    pid = JSON.parse(
      NodeFS.readFileSync(NodePath.join(userdata, "server-runtime.json"), "utf8"),
    ).pid;
    if (typeof pid !== "number") return;
    process.kill(pid, 0);
  } catch {
    return;
  }
  fail(
    `the installed T3 Code app is running against ${userdata}; pairing here would target it instead of your dev server. Pass --url <pairing url from vp run dev>, or run from a worktree / with --home-dir.`,
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

function pairWithDevServer(homeDir) {
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [serverBin, "pair", "--base-dir", homeDir],
    { cwd: appDir, encoding: "utf8" },
  );
  const url = findPairingUrl(`${result.stdout}\n${result.stderr}`);
  if (url !== undefined) return url;
  // `pair` logs its "No running T3 Code server" report (with the state paths it
  // checked) through the Effect logger, i.e. on stdout.
  process.stderr.write(`${result.stdout}${result.stderr}`.trim() + "\n");
  return fail(
    `no running dev server under ${homeDir}. Start \`vp run dev\` in another terminal first (same --home-dir), or pass --url <pairing url>.`,
  );
}

build();
if (options.configureOnly) process.exit(0);

const homeDir = resolveHomeDir();
const url = options.url ?? pairWithDevServer(homeDir);
const binary = binaryPath();
const binaryArgs = ["--url", url, ...shellArgs];
process.stderr.write(`[dev-qt] home ${homeDir}\n`);
process.stderr.write(`[dev-qt] launching ${binary} ${binaryArgs.join(" ")}\n`);
const child = NodeChildProcess.spawn(binary, binaryArgs, {
  stdio: "inherit",
  cwd: appDir,
  env: { ...process.env, T3CODE_HOME: homeDir },
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => process.exit(code ?? 0));
