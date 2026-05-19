import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(scriptsDir, "..");
const srcDir = resolve(serverDir, "src");
const entry = resolve(srcDir, "bin.ts");
const sourceExtensions = new Set([".cjs", ".cts", ".js", ".json", ".mjs", ".mts", ".ts"]);

let child;
let restartTimer;
let stopping = false;

function start() {
  child = spawn(process.execPath, [entry], {
    stdio: "inherit",
    env: process.env,
    cwd: serverDir,
  });

  child.on("exit", (code, signal) => {
    if (stopping || restartTimer) {
      return;
    }
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

async function shouldRestart(filename) {
  if (!filename || typeof filename !== "string") {
    return false;
  }

  const changedPath = resolve(srcDir, filename);
  if (!changedPath.startsWith(`${srcDir}/`)) {
    return false;
  }

  try {
    const changedStat = await stat(changedPath);
    if (changedStat.isDirectory()) {
      return false;
    }
  } catch {
    // Deleted source files still need a restart.
  }

  return sourceExtensions.has(extname(changedPath));
}

function scheduleRestart() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = undefined;
    console.log("Restarting server...");

    const previous = child;
    previous.once("exit", () => {
      if (!stopping) {
        start();
      }
    });
    previous.kill("SIGTERM");
  }, 100);
}

const watcher = watch(srcDir, { recursive: true }, async (_event, filename) => {
  if (await shouldRestart(filename)) {
    scheduleRestart();
  }
});

function shutdown(signal) {
  stopping = true;
  clearTimeout(restartTimer);
  watcher.close();
  if (!child || child.killed) {
    process.exit(0);
  }
  child.once("exit", () => process.exit(0));
  child.kill(signal);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start();
