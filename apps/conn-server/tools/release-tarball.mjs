#!/usr/bin/env node
// Builds the release that Orbit puts in its agent folder, or the macOS release folder:
//
//   conn-server-<version>-linux-x64.tar.gz
//   └── conn-server-<version>-linux-x64/
//       ├── chrome.json            the generated Linux Chrome pin
//       ├── conn-server            the x86_64-unknown-linux-musl binary (static)
//       └── sdk-host/              the SDK host: index.mjs, drivers/, package.json, the lockfile
//           └── node_modules/      production dependencies only (the Claude Agent SDK)
//
// The server finds `sdk-host/index.mjs` beside its own binary (after it follows Orbit's link in
// `bin/`) and runs it with `node` from PATH; Orbit's runtime folder gives Node 24.22.1.
//
// Usage: node tools/release-tarball.mjs [--platform linux-x64|macos-arm64] [--out <dir>]
//          [--binary <prebuilt conn-server>]
// linux-x64 (the default) builds on Linux x86_64 only (musl-gcc and GNU tar). It prints the
// tarball's path and sha256, and writes `<tarball>.sha256` in `sha256sum` format.
// macos-arm64 builds on an arm64 Mac (target aarch64-apple-darwin) and writes the same layout
// as the folder `<out>/conn-server-<version>-macos-arm64/`, without a tarball: the input of
// tools/macos-app.sh, which signs it into Conn Server.app. The version is the workspace version
// in Cargo.toml. cargo's output goes to CARGO_TARGET_DIR when set, else `target/`.
//
// Sealed (AGENTS.md, Safety): cargo runs with `cargoBuildEnv` (a throwaway HOME, no global git
// configuration), npm with `sealedNodeEnv` (a throwaway HOME, so no ~/.npmrc or token), no
// global npmrc, and `--ignore-scripts`, as CI installs it.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import { cargoBuildEnv, sealedNodeEnv } from "./sealed-env.mjs";

/** Per platform: the Rust target and the host that builds it (`process.platform`, `arch`). */
const PLATFORMS = {
  "linux-x64": { target: "x86_64-unknown-linux-musl", os: "linux", arch: "x64", tarball: true },
  "macos-arm64": { target: "aarch64-apple-darwin", os: "darwin", arch: "arm64", tarball: false },
};
/** What the tarball takes from helpers/sdk-host; nothing else (no build tools, no docs). */
const SDK_HOST_FILES = ["index.mjs", "drivers", "package.json", "package-lock.json", ".npmrc"];
/** The only package the SDK host may ship (its one runtime dependency). */
const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

const repo = NodePath.resolve(NodePath.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`release-tarball: ${message}`);
  process.exit(1);
}

function option(name) {
  const at = process.argv.indexOf(name);
  if (at === -1) return undefined;
  const value = process.argv[at + 1];
  if (value === undefined || value.startsWith("--")) fail(`${name} needs a value`);
  return value;
}

function run(program, args, options) {
  const result = NodeChildProcess.spawnSync(program, args, { stdio: "inherit", ...options });
  if (result.error) fail(`${program}: ${result.error.message}`);
  if (result.status !== 0) fail(`${program} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
  return result;
}

/** The `version` of `[workspace.package]` in the workspace Cargo.toml. */
function workspaceVersion(cargoToml) {
  const section = /^\[workspace\.package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(cargoToml)?.[1] ?? "";
  const version = /^version\s*=\s*"([^"]+)"\s*$/m.exec(section)?.[1];
  if (version === undefined) fail("no version in [workspace.package] of Cargo.toml");
  return version;
}

const PLATFORM = option("--platform") ?? "linux-x64";
const platform = PLATFORMS[PLATFORM];
if (platform === undefined) fail(`--platform must be one of ${Object.keys(PLATFORMS).join(", ")}, not ${PLATFORM}`);
const TARGET = platform.target;
if (process.platform !== platform.os || process.arch !== platform.arch) {
  fail(`${PLATFORM} builds on ${platform.os} ${platform.arch} only (here ${process.platform} ${process.arch})`);
}
const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "conn-release-"));
process.once("exit", () => NodeFS.rmSync(work, { recursive: true, force: true }));
/** For tar, gzip and the smoke runs: no variable of the shell beyond what a process needs. */
const plainEnv = sealedNodeEnv(NodePath.join(work, "plain"));

if (platform.tarball) {
  const gnuTar = NodeChildProcess.spawnSync("tar", ["--version"], { encoding: "utf8", env: plainEnv });
  if (!/GNU tar/.test(gnuTar.stdout ?? "")) fail("needs GNU tar (for --sort, --owner and --mtime)");
}

const version = workspaceVersion(NodeFS.readFileSync(NodePath.join(repo, "Cargo.toml"), "utf8"));
const name = `conn-server-${version}-${PLATFORM}`;
const outDir = NodePath.resolve(option("--out") ?? NodePath.join(repo, "target/release-tarball"));

// ---- the binary ---------------------------------------------------------------------------
let binary = option("--binary");
if (binary === undefined) {
  const env = cargoBuildEnv(NodePath.join(work, "cargo"));
  if (TARGET.endsWith("-musl")) env.CC_x86_64_unknown_linux_musl ??= "musl-gcc";
  run("cargo", ["build", "--locked", "--release", "--target", TARGET, "-p", "conn-server"], { cwd: repo, env });
  const targetDir = process.env.CARGO_TARGET_DIR ? NodePath.resolve(repo, process.env.CARGO_TARGET_DIR) : NodePath.join(repo, "target");
  binary = NodePath.join(targetDir, TARGET, "release", "conn-server");
}
binary = NodePath.resolve(binary);
const reported = NodeChildProcess.spawnSync(binary, ["--version"], { encoding: "utf8", env: plainEnv });
if (reported.status !== 0 || !reported.stdout.includes(version)) {
  fail(`${binary} --version printed ${JSON.stringify(reported.stdout ?? "")}, not version ${version}`);
}

// ---- the folder -----------------------------------------------------------------------------
const stage = NodePath.join(work, "stage");
const top = NodePath.join(stage, name);
const sdkHost = NodePath.join(top, "sdk-host");
NodeFS.mkdirSync(sdkHost, { recursive: true });
NodeFS.copyFileSync(binary, NodePath.join(top, "conn-server"));
NodeFS.chmodSync(NodePath.join(top, "conn-server"), 0o755);
NodeFS.copyFileSync(NodePath.join(repo, "crates/conn-preview/chrome.json"), NodePath.join(top, "chrome.json"));
for (const file of SDK_HOST_FILES) {
  NodeFS.cpSync(NodePath.join(repo, "helpers/sdk-host", file), NodePath.join(sdkHost, file), { recursive: true });
}

// The lockfile only, production dependencies only, no install script; the SDK host's .npmrc
// leaves out the SDK's optional platform packages (each bundles a claude binary), as T3 does.
const npmEnv = {
  ...sealedNodeEnv(NodePath.join(work, "npm")),
  npm_config_cache: NodePath.join(work, "npm-cache"),
  npm_config_globalconfig: "/dev/null",
  npm_config_update_notifier: "false",
};
run("npm", ["ci", "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: sdkHost, env: npmEnv });
NodeFS.rmSync(NodePath.join(sdkHost, "node_modules/.package-lock.json"), { force: true });

const shipped = [];
for (const entry of NodeFS.readdirSync(NodePath.join(sdkHost, "node_modules"), { withFileTypes: true })) {
  if (entry.name.startsWith("@")) {
    for (const inner of NodeFS.readdirSync(NodePath.join(sdkHost, "node_modules", entry.name))) shipped.push(`${entry.name}/${inner}`);
  } else shipped.push(entry.name);
}
if (JSON.stringify(shipped) !== JSON.stringify([SDK_PACKAGE])) {
  fail(`node_modules holds ${JSON.stringify(shipped)}, expected only ${SDK_PACKAGE}`);
}

// The host starts, says ready, and exits on shutdown; the SDK module loads under this node.
const smoke = NodeChildProcess.spawnSync("node", [NodePath.join(sdkHost, "index.mjs")], {
  input: '{"t":"shutdown"}\n',
  encoding: "utf8",
  env: plainEnv,
  timeout: 30_000,
});
if (smoke.status !== 0 || !/"t":"ready"/.test(smoke.stdout)) fail(`the SDK host did not start: ${smoke.stdout}${smoke.stderr}`);
const load = NodeChildProcess.spawnSync(
  "node",
  ["--input-type=module", "-e", `const m = await import(${JSON.stringify(SDK_PACKAGE)}); if (typeof m.query !== "function") process.exit(3);`],
  { cwd: sdkHost, encoding: "utf8", env: plainEnv, timeout: 30_000 },
);
if (load.status !== 0) fail(`the Claude Agent SDK did not load: ${load.stderr}`);

// ---- the macOS folder -----------------------------------------------------------------------
if (!platform.tarball) {
  const folder = NodePath.join(outDir, name);
  NodeFS.rmSync(folder, { recursive: true, force: true });
  NodeFS.mkdirSync(outDir, { recursive: true });
  NodeFS.cpSync(top, folder, { recursive: true, verbatimSymlinks: true });
  console.log(`folder  ${folder}`);
  process.exit(0);
}

// ---- the tarball ----------------------------------------------------------------------------
// Same input, same bytes: sorted names, root owner, one time, gzip without a name or time.
const epoch = process.env.SOURCE_DATE_EPOCH ?? gitCommitTime();
NodeFS.mkdirSync(outDir, { recursive: true });
const tarball = NodePath.join(outDir, `${name}.tar.gz`);
const tar = NodeChildProcess.spawnSync(
  "tar",
  ["--sort=name", "--owner=0", "--group=0", "--numeric-owner", `--mtime=@${epoch}`, "--mode=u+rwX,go+rX,go-w", "-C", stage, "-cf", "-", name],
  { env: plainEnv, maxBuffer: 1024 * 1024 * 1024 },
);
if (tar.status !== 0) fail(`tar: ${tar.stderr}`);
const gzip = NodeChildProcess.spawnSync("gzip", ["-n", "-9"], { input: tar.stdout, env: plainEnv, maxBuffer: 1024 * 1024 * 1024 });
if (gzip.status !== 0) fail(`gzip: ${gzip.stderr}`);
NodeFS.writeFileSync(tarball, gzip.stdout);
const sha256 = NodeCrypto.createHash("sha256").update(gzip.stdout).digest("hex");
NodeFS.writeFileSync(`${tarball}.sha256`, `${sha256}  ${NodePath.basename(tarball)}\n`);

console.log(`tarball ${tarball}`);
console.log(`bytes   ${gzip.stdout.length}`);
console.log(`sha256  ${sha256}`);
console.log(`bin     conn-server: ${name}/conn-server`);

function gitCommitTime() {
  const env = { ...plainEnv, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const out = NodeChildProcess.spawnSync("git", ["log", "-1", "--format=%ct"], { cwd: repo, encoding: "utf8", env });
  return out.status === 0 && /^\d+$/.test(out.stdout.trim()) ? out.stdout.trim() : "0";
}
