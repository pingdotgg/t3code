#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${arg}`);
    if (arg === "--server-root") options.serverRoot = value;
    else if (arg === "--node-pty") options.nodePty = value;
    else if (arg === "--node-runtime") options.nodeRuntime = value;
    else if (arg === "--manifest") options.manifest = value;
    else if (arg === "--arch") options.arch = value;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const key of ["serverRoot", "nodePty", "nodeRuntime", "manifest", "arch"]) {
    if (!options[key]) throw new Error(`Missing required option: ${key}`);
  }
  return options;
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function resolveNativeRuntime(serverRoot, arch) {
  const serverRequire = createRequire(path.join(path.resolve(serverRoot), "package.json"));
  const ptyManifest = serverRequire.resolve("node-pty/package.json");
  const ptyDir = path.dirname(ptyManifest);
  const fffNodeEntry = serverRequire.resolve("@ff-labs/fff-node");
  const fffRequire = createRequire(fffNodeEntry);
  const fffPath = fffRequire.resolve(`@ff-labs/fff-bin-linux-${arch}-gnu`);
  const ffiEntry = fffRequire.resolve("ffi-rs");
  const ffiRequire = createRequire(ffiEntry);
  const ffiPath = ffiRequire.resolve(`@yuuang/ffi-rs-linux-${arch}-gnu`);
  return { serverRequire, ptyDir, fffPath, ffiPath };
}

function verifyManifestHashes(manifest, paths) {
  const byName = new Map(manifest.artifacts.map((artifact) => [artifact.name, artifact]));
  for (const [name, filePath] of Object.entries(paths)) {
    const expected = byName.get(name);
    if (!expected) throw new Error(`ABI manifest is missing artifact ${name}.`);
    const actual = sha256File(filePath);
    if (actual !== expected.sha256) {
      throw new Error(`${name} hash differs from the ABI-audited artifact: expected ${expected.sha256}, got ${actual}.`);
    }
  }
}

async function smokeNodePty(serverRequire, ptyDir, prebuildPath, arch) {
  const destination = path.join(ptyDir, "prebuilds", `linux-${arch}`, "pty.node");
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(path.resolve(prebuildPath), destination);
  const nodePty = serverRequire("node-pty");
  await new Promise((resolve, reject) => {
    let output = "";
    const terminal = nodePty.spawn("/bin/sh", ["-lc", "printf T3CODE_WSL_PTY_OK"], {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    });
    const timeout = setTimeout(() => {
      try {
        terminal.kill();
      } catch {}
      reject(new Error("node-pty WSL smoke test timed out."));
    }, 5000);
    terminal.onData((chunk) => {
      output += chunk;
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode !== 0 || !output.includes("T3CODE_WSL_PTY_OK")) {
        reject(new Error(`node-pty smoke failed (exit ${exitCode}): ${JSON.stringify(output)}`));
      } else {
        resolve();
      }
    });
  });
}

function smokeFffDynamicDependencies(fffPath) {
  const dynamic = spawnSync("readelf", ["-d", fffPath], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (dynamic.error || dynamic.status !== 0) {
    throw new Error(
      `Could not inspect audited fff Linux binary: ${dynamic.error?.message ?? dynamic.stderr ?? `readelf exited ${dynamic.status}`}`,
    );
  }
  // A fully-static ELF has no DT_NEEDED entries and `ldd` intentionally exits
  // non-zero for it, so static binaries pass this loader smoke without ldd.
  if (!/Shared library: \[[^\]]+\]/.test(dynamic.stdout ?? "")) return;

  const result = spawnSync("ldd", [fffPath], {
    encoding: "utf8",
    timeout: 5000,
  });
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.error) throw new Error(`Could not inspect audited fff Linux binary: ${result.error.message}`);
  if (result.status !== 0 || /\bnot found\b/i.test(combined)) {
    throw new Error(`fff failed dynamic-loader compatibility smoke:\n${combined}`);
  }
}

function smokeFfiNative(ffiPath) {
  createRequire(import.meta.url)(ffiPath);
}

export async function runSmoke(options) {
  const manifest = JSON.parse(readFileSync(path.resolve(options.manifest), "utf8"));
  if (manifest?.schemaVersion !== 2) throw new Error("Unsupported WSL ABI manifest schema.");
  if (manifest?.baseline?.arch !== options.arch) {
    throw new Error(`ABI manifest architecture ${manifest?.baseline?.arch ?? "unknown"} does not match ${options.arch}.`);
  }

  const bundledNode = path.resolve(options.nodeRuntime);
  const runtimeVersion = spawnSync(bundledNode, ["-p", "process.versions.node"], { encoding: "utf8", timeout: 5000 });
  if (runtimeVersion.error || runtimeVersion.status !== 0) {
    throw new Error(`Bundled Node runtime could not execute: ${runtimeVersion.error?.message ?? runtimeVersion.stderr ?? `exit ${runtimeVersion.status}`}`);
  }
  const actualNodeVersion = (runtimeVersion.stdout ?? "").trim();
  if (actualNodeVersion !== manifest?.nodeRuntime?.version) {
    throw new Error(`Bundled Node runtime version mismatch: manifest ${manifest?.nodeRuntime?.version ?? "unknown"}, binary ${actualNodeVersion || "unknown"}.`);
  }

  const runtime = resolveNativeRuntime(options.serverRoot, options.arch);
  verifyManifestHashes(manifest, {
    "node-runtime": bundledNode,
    "node-pty": path.resolve(options.nodePty),
    fff: runtime.fffPath,
    "ffi-rs": runtime.ffiPath,
  });

  await smokeNodePty(runtime.serverRequire, runtime.ptyDir, options.nodePty, options.arch);
  smokeFffDynamicDependencies(runtime.fffPath);
  smokeFfiNative(runtime.ffiPath);

  console.log(
    `[wsl-runtime-smoke] PASS ${manifest.baseline.id}/${options.arch}: bundled Node ${manifest.nodeRuntime.version}, node-pty PTY spawn, fff dependency resolution, ffi-rs native require`,
  );
}

async function main() {
  await runSmoke(parseArgs(process.argv.slice(2)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
