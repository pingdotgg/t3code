#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const image = process.env.T3CODE_PODMAN_IMAGE?.trim() || "docker.io/oven/bun:1";
const cacheDir =
  process.env.T3CODE_PODMAN_CACHE_DIR?.trim() || join(homedir(), ".cache", "t3code-podman");
const forwardedArgs = process.argv.slice(2);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function runOrExit(command: string, args: ReadonlyArray<string>) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
}

const podmanCheck = spawnSync("podman", ["--version"], {
  cwd: repoRoot,
  stdio: "ignore",
});

if (podmanCheck.error || podmanCheck.status !== 0) {
  console.error("podman is required for dist:desktop:linux:rpm:podman.");
  process.exit(1);
}

mkdirSync(cacheDir, { recursive: true });

const installPackages = ["git", "python3", "make", "g++", "rpm"];
const innerCommandParts = [
  "set -euo pipefail",
  "apt-get update",
  `DEBIAN_FRONTEND=noninteractive apt-get install -y ${installPackages.join(" ")}`,
  "bun install --ignore-scripts",
];

const rpmBuildCommand = ["bun", "run", "dist:desktop:linux:rpm"];
if (forwardedArgs.length > 0) {
  rpmBuildCommand.push("--", ...forwardedArgs);
}
const rpmBuildCommandString = rpmBuildCommand.map(shellQuote).join(" ");
innerCommandParts.push(
  `if ! ${rpmBuildCommandString}; then echo 'Retrying RPM build after warming electron-builder cache...' >&2; ${rpmBuildCommandString}; fi`,
);

runOrExit("podman", [
  "run",
  "--rm",
  "-v",
  `${repoRoot}:/workspace:Z`,
  "-v",
  `${cacheDir}:/root/.cache:Z`,
  "-w",
  "/workspace",
  image,
  "bash",
  "-lc",
  innerCommandParts.join(" && "),
]);
