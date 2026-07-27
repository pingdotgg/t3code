#!/usr/bin/env node
// Stage the standalone server sidecar for embedding into the SurgeCode
// installer — the Windows counterpart of `apps/mac/scripts/stage-sidecar.sh`.
//
// Assembles apps/windows/dist-sidecar/ with:
//   SergeCodeNode/node.exe   official win-x64 Node binary (pinned, checksum-verified)
//   SergeCodeServer/         apps/server bundle (bin.mjs + chunks) plus a
//                            production-only node_modules (via `pnpm deploy`)
//
// `tauri.conf.json` declares both directories as bundle resources, so run this
// before `tauri build` for anything you intend to ship. Dev builds skip
// staging entirely and resolve node/dist against the local checkout at
// runtime (see `src-tauri/src/sidecar/config.rs`).
//
// Written in Node rather than a shell script so it runs identically from
// PowerShell, cmd, and a POSIX shell — a Windows release must not depend on
// having bash installed. Host platform/arch come from `node:os` rather than
// the `process` global, which the repository's lint rules reserve for Effect's
// injected runtime services.
//
// Env overrides:
//   SERGE_CODE_SIDECAR_STAGING  staging directory (default: apps/windows/dist-sidecar)
//   SERGE_CODE_NODE_VERSION     Node version to stage (default: pinned below)
//   SERGE_CODE_NODE_ARCH        x64 | arm64 (default: the host arch)

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

// Pinned Node 24 LTS (Krypton): satisfies apps/server engines
// (^22.16 || ^23.11 || >=24.10) and stays on the Active LTS line. Kept in sync
// with apps/mac/scripts/stage-sidecar.sh — the two clients must not drift onto
// different runtimes.
const NODE_VERSION = NodeProcess.env.SERGE_CODE_NODE_VERSION ?? "24.18.0";

// Whether *this* machine is Windows — not what we are building for. It only
// decides whether `spawnSync` needs a shell, whether `where` or `which` finds
// pnpm, and whether the staged node.exe can be executed to verify itself. This
// is a standalone build script with no Effect runtime to inject a
// HostProcessPlatform from, and no test that would provide one.
// oxlint-disable-next-line t3code/no-global-process-runtime
const IS_WINDOWS_HOST = NodeOS.platform() === "win32";

const WINDOWS_DIR = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const REPO_ROOT = NodePath.resolve(WINDOWS_DIR, "..", "..");
const STAGING =
  NodeProcess.env.SERGE_CODE_SIDECAR_STAGING ?? NodePath.join(WINDOWS_DIR, "dist-sidecar");
const NODE_OUT = NodePath.join(STAGING, "SergeCodeNode");
const SERVER_OUT = NodePath.join(STAGING, "SergeCodeServer");

// The architecture of the *installer being produced*, which is a property of
// the build target rather than of this machine — a packaging run can perfectly
// well happen on an arm64 macOS host. x64 covers every Windows box this ships
// to today; set SERGE_CODE_NODE_ARCH=arm64 to stage a Windows-on-ARM build.
const NODE_ARCH = NodeProcess.env.SERGE_CODE_NODE_ARCH ?? "x64";

function fail(message) {
  NodeProcess.stderr.write(`error: ${message}\n`);
  NodeProcess.exit(1);
}

function run(command, args, options = {}) {
  const result = NodeChildProcess.spawnSync(command, args, {
    stdio: "inherit",
    shell: IS_WINDOWS_HOST,
    ...options,
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited with ${result.status ?? "a signal"}`);
  }
  return result;
}

function capture(command, args, options = {}) {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    shell: IS_WINDOWS_HOST,
    ...options,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    fail(`GET ${url} -> HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  NodeFS.writeFileSync(destination, bytes);
  return bytes;
}

async function stageNodeRuntime() {
  const stagedExe = NodePath.join(NODE_OUT, "node.exe");
  // Only a Windows host can execute the staged binary to confirm its version;
  // elsewhere (a macOS/Linux packaging run) trust the checksum instead.
  if (NodeFS.existsSync(stagedExe) && IS_WINDOWS_HOST) {
    if (capture(stagedExe, ["--version"]) === `v${NODE_VERSION}`) {
      NodeProcess.stdout.write(`Node runtime v${NODE_VERSION} already staged at ${stagedExe}\n`);
      return;
    }
  }

  const archiveName = `node-v${NODE_VERSION}-win-${NODE_ARCH}.zip`;
  const distUrl = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sergecode-node-"));

  try {
    NodeProcess.stdout.write(`Downloading ${distUrl}/${archiveName}\n`);
    const archivePath = NodePath.join(work, archiveName);
    const bytes = await download(`${distUrl}/${archiveName}`, archivePath);
    const shasums = await download(
      `${distUrl}/SHASUMS256.txt`,
      NodePath.join(work, "SHASUMS256.txt"),
    );

    const expected = shasums
      .toString("utf8")
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find((parts) => parts[1] === archiveName)?.[0];
    if (!expected) {
      fail(`no SHA-256 entry for ${archiveName} in SHASUMS256.txt`);
    }
    const actual = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
      fail(`SHA-256 mismatch for ${archiveName}\n  expected: ${expected}\n  actual:   ${actual}`);
    }

    // `tar` on Windows 10 1803+ is bsdtar, which reads zip archives, so this
    // one command works on every host that can run this script.
    run("tar", ["-xf", archivePath, "-C", work]);
    const extracted = NodePath.join(work, `node-v${NODE_VERSION}-win-${NODE_ARCH}`, "node.exe");
    if (!NodeFS.existsSync(extracted)) {
      fail("archive did not contain node.exe");
    }

    NodeFS.rmSync(NODE_OUT, { recursive: true, force: true });
    NodeFS.mkdirSync(NODE_OUT, { recursive: true });
    NodeFS.copyFileSync(extracted, stagedExe);
    NodeProcess.stdout.write(`Staged Node v${NODE_VERSION} at ${stagedExe}\n`);
  } finally {
    NodeFS.rmSync(work, { recursive: true, force: true });
  }
}

function stageServerPayload() {
  if (!NodeFS.existsSync(NodePath.join(REPO_ROOT, "apps", "server", "dist", "bin.mjs"))) {
    fail("apps/server/dist/bin.mjs is missing; run 'vp run build:server' first");
  }

  // bin.mjs is bundled but externalizes its runtime dependencies, so the app
  // must ship a production-only node_modules next to it. `pnpm deploy --legacy`
  // materializes exactly that; --legacy is required because the workspace does
  // not set inject-workspace-packages=true.
  const pnpm = capture(IS_WINDOWS_HOST ? "where" : "which", ["pnpm"])
    ? ["pnpm"]
    : ["corepack", "pnpm"];
  const deployDir = NodePath.join(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sergecode-deploy-")),
    "deploy",
  );

  NodeProcess.stdout.write("Deploying production server payload with pnpm deploy\n");
  run(pnpm[0], [...pnpm.slice(1), "--filter", "t3", "deploy", "--prod", "--legacy", deployDir], {
    cwd: REPO_ROOT,
  });

  NodeFS.rmSync(SERVER_OUT, { recursive: true, force: true });
  NodeFS.mkdirSync(SERVER_OUT, { recursive: true });
  NodeFS.cpSync(NodePath.join(deployDir, "dist"), SERVER_OUT, { recursive: true });
  NodeFS.cpSync(
    NodePath.join(deployDir, "node_modules"),
    NodePath.join(SERVER_OUT, "node_modules"),
    {
      recursive: true,
      // pnpm's store is symlinked; the installer needs real files.
      dereference: true,
    },
  );
  NodeFS.copyFileSync(
    NodePath.join(deployDir, "package.json"),
    NodePath.join(SERVER_OUT, "package.json"),
  );

  prunePrebuilds(NodePath.join(SERVER_OUT, "node_modules"));
  NodeFS.rmSync(NodePath.dirname(deployDir), { recursive: true, force: true });
}

// Native deps (node-pty, bufferutil, utf-8-validate) ship prebuilds for every
// platform; the installer only ever runs on this one, and the rest are ~60 MB.
function prunePrebuilds(root) {
  const keep = `win32-${NODE_ARCH}`;
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    let entries;
    try {
      entries = NodeFS.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const full = NodePath.join(directory, entry.name);
      if (NodePath.basename(directory) === "prebuilds" && entry.name !== keep) {
        NodeFS.rmSync(full, { recursive: true, force: true });
        continue;
      }
      stack.push(full);
    }
  }
}

function verifyStagedPayload() {
  if (!IS_WINDOWS_HOST) {
    NodeProcess.stdout.write("Skipping the boot check: the staged node.exe cannot run here.\n");
    return;
  }
  run(NodePath.join(NODE_OUT, "node.exe"), [NodePath.join(SERVER_OUT, "bin.mjs"), "--version"], {
    stdio: "ignore",
  });
}

await stageNodeRuntime();
stageServerPayload();
verifyStagedPayload();
NodeProcess.stdout.write(`Sidecar staging complete: ${STAGING}\n`);
