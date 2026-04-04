import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, "..");
const bunExecutable = process.execPath;
const childScriptNames = ["dev:bundle", "dev:electron"];
const forcedShutdownTimeoutMs = 1_500;

const children = new Map();
let shuttingDown = false;
let forcedShutdownTimer = null;
let exitCode = 0;
let exitSignal = null;

function maybeExit() {
  if (children.size > 0) {
    return;
  }

  if (forcedShutdownTimer !== null) {
    clearTimeout(forcedShutdownTimer);
    forcedShutdownTimer = null;
  }

  if (exitSignal !== null) {
    process.kill(process.pid, exitSignal);
    return;
  }

  process.exit(exitCode);
}

function stopRemainingChildren() {
  for (const child of children.values()) {
    child.kill("SIGTERM");
  }

  if (forcedShutdownTimer !== null) {
    return;
  }

  forcedShutdownTimer = setTimeout(() => {
    for (const child of children.values()) {
      child.kill("SIGKILL");
    }
  }, forcedShutdownTimeoutMs);
  forcedShutdownTimer.unref();
}

function shutdown({ code = 0, signal = null } = {}) {
  if (shuttingDown) {
    if (code !== 0 && exitCode === 0) {
      exitCode = code;
    }
    if (signal !== null && exitSignal === null) {
      exitSignal = signal;
    }
    return;
  }

  shuttingDown = true;
  exitCode = code;
  exitSignal = signal;
  stopRemainingChildren();
  maybeExit();
}

function startChild(scriptName) {
  const child = spawn(bunExecutable, ["run", scriptName], {
    cwd: desktopDir,
    env: process.env,
    stdio: "inherit",
  });

  children.set(scriptName, child);

  child.once("error", (error) => {
    console.error(`[desktop-dev] Failed to start ${scriptName}`, error);
    children.delete(scriptName);
    shutdown({ code: 1 });
  });

  child.once("exit", (code, signal) => {
    children.delete(scriptName);

    if (shuttingDown) {
      if (code !== null && code !== 0 && exitCode === 0) {
        exitCode = code;
      }
      if (signal !== null && exitSignal === null) {
        exitSignal = signal;
      }
      maybeExit();
      return;
    }

    if (signal !== null) {
      shutdown({ signal });
      return;
    }

    shutdown({ code: code ?? 1 });
  });
}

for (const scriptName of childScriptNames) {
  startChild(scriptName);
}

process.once("SIGINT", () => {
  shutdown({ code: 130 });
});

process.once("SIGTERM", () => {
  shutdown({ code: 143 });
});
