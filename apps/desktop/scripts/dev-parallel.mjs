#!/usr/bin/env node
/**
 * Run tsdown --watch and the Electron dev launcher concurrently.
 *
 * Replaces `bun run --parallel dev:bundle dev:electron`, which doesn't work
 * on bun 1.3.0 (the `--parallel` flag was removed/never-landed and bun silently
 * treats it as an unknown flag, collapsing the two scripts into one invocation).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");

const children = [];
let shuttingDown = false;

function startChild(label, script) {
  const child = spawn(process.platform === "win32" ? "bun.exe" : "bun", ["run", script], {
    cwd: desktopDir,
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    const reason = signal ?? code;
    console.error(`[dev-parallel] ${label} exited (${reason}); tearing down siblings.`);
    shutdown(typeof code === "number" ? code : 1);
  });
  children.push({ label, child });
}

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (!child.killed) {
      child.kill(process.platform === "win32" ? undefined : "SIGTERM");
    }
  }
  setTimeout(() => process.exit(exitCode), 500).unref();
}

process.once("SIGINT", () => shutdown(130));
process.once("SIGTERM", () => shutdown(143));

startChild("dev:bundle", "dev:bundle");
startChild("dev:electron", "dev:electron");
