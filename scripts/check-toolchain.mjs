#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FALLBACK_NODE_VERSION = "24.13.1";
const FALLBACK_BUN_VERSION = "1.3.9";

function readMiseToolVersion(toolName) {
  const misePath = join(import.meta.dirname, "..", ".mise.toml");
  const contents = readFileSync(misePath, "utf8");
  const match = contents.match(new RegExp(`^${toolName}\\s*=\\s*"([^"]+)"$`, "m"));
  return match?.[1] ?? null;
}

function normalizeVersion(version) {
  return version.startsWith("v") ? version.slice(1) : version;
}

function parseVersion(version) {
  const [major = "0", minor = "0", patch = "0"] = normalizeVersion(version).split(".");
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  };
}

function isCompatibleVersion(current, expected) {
  if (current.major !== expected.major) {
    return false;
  }
  if (current.minor !== expected.minor) {
    return current.minor > expected.minor;
  }
  return current.patch >= expected.patch;
}

function readCurrentBunVersion() {
  try {
    return normalizeVersion(execFileSync("bun", ["--version"], { encoding: "utf8" }).trim());
  } catch {
    return null;
  }
}

function exitWithToolingGuidance(message) {
  console.error(message);
  console.error("");
  console.error("Fix:");
  console.error("  1. Run `mise install`.");
  console.error(
    "  2. Activate mise in your shell so this repo picks the right Node/Bun automatically.",
  );
  console.error("  3. Or run commands with `mise exec node@24.13.1 -- bun run <script>`.");
  process.exit(1);
}

const expectedNodeVersion = readMiseToolVersion("node") ?? FALLBACK_NODE_VERSION;
const expectedBunVersion = readMiseToolVersion("bun") ?? FALLBACK_BUN_VERSION;
const currentNodeVersion = normalizeVersion(process.version);
const currentBunVersion = readCurrentBunVersion();

if (!isCompatibleVersion(parseVersion(currentNodeVersion), parseVersion(expectedNodeVersion))) {
  exitWithToolingGuidance(
    `This repo requires Node ${expectedNodeVersion}, but current Node is ${currentNodeVersion}.`,
  );
}

if (
  currentBunVersion &&
  !isCompatibleVersion(parseVersion(currentBunVersion), parseVersion(expectedBunVersion))
) {
  exitWithToolingGuidance(
    `This repo requires Bun ${expectedBunVersion}, but current Bun is ${currentBunVersion}.`,
  );
}
