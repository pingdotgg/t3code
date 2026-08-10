#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${key}`);
    if (key === "--server-root") options.serverRoot = value;
    else if (key === "--runtime-dir") options.runtimeDir = value;
    else if (key === "--arch") options.arch = value;
    else throw new Error(`Unknown option: ${key}`);
  }
  for (const key of ["serverRoot", "runtimeDir", "arch"]) {
    if (!options[key]) throw new Error(`Missing required option: ${key}`);
  }
  return options;
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function stageWslCiNodePty(options) {
  const serverRoot = path.resolve(options.serverRoot);
  const runtimeDir = path.resolve(options.runtimeDir);
  const runtimeManifestPath = path.join(runtimeDir, "wsl-native-abi.json");
  const runtimeManifest = JSON.parse(readFileSync(runtimeManifestPath, "utf8"));
  if (runtimeManifest?.schemaVersion !== 2) {
    throw new Error(`Unsupported WSL ABI manifest schema in ${runtimeManifestPath}`);
  }

  const auditedPty = runtimeManifest.artifacts?.find((artifact) => artifact.name === "node-pty");
  if (!auditedPty?.sha256) throw new Error("WSL ABI manifest is missing node-pty SHA-256.");

  const sourcePty = path.join(runtimeDir, "pty.node");
  const sourceSha256 = sha256File(sourcePty);
  if (sourceSha256 !== auditedPty.sha256) {
    throw new Error(
      `CI node-pty artifact hash mismatch: manifest ${auditedPty.sha256}, file ${sourceSha256}.`,
    );
  }

  const serverRequire = createRequire(path.join(serverRoot, "package.json"));
  const nodePtyManifestPath = serverRequire.resolve("node-pty/package.json");
  const nodePtyDir = path.dirname(nodePtyManifestPath);
  const nodePtyManifest = JSON.parse(readFileSync(nodePtyManifestPath, "utf8"));
  if (typeof nodePtyManifest.version !== "string" || nodePtyManifest.version.length === 0) {
    throw new Error(`Invalid node-pty package version in ${nodePtyManifestPath}`);
  }

  const prebuildDir = path.join(nodePtyDir, "prebuilds", `linux-${options.arch}`);
  mkdirSync(prebuildDir, { recursive: true });
  copyFileSync(sourcePty, path.join(prebuildDir, "pty.node"));
  const marker = {
    arch: options.arch,
    nodePtyVersion: nodePtyManifest.version,
    sha256: sourceSha256,
    abiBaseline: runtimeManifest.baseline?.id ?? "unknown",
    glibcCeiling: runtimeManifest.baseline?.limits?.glibc ?? "unknown",
  };
  writeFileSync(
    path.join(prebuildDir, "t3code-wsl-node-pty.json"),
    `${JSON.stringify(marker)}\n`,
    "utf8",
  );
  console.log(
    `[wsl-ci-stage] staged node-pty ${nodePtyManifest.version} (${sourceSha256}) -> ${prebuildDir}`,
  );
  return { prebuildDir, marker };
}

function main() {
  stageWslCiNodePty(parseArgs(process.argv.slice(2)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}
