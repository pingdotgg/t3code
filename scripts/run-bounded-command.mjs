#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";

const [, , command, ...args] = process.argv;

if (command === undefined) {
  console.error("Usage: run-bounded-command.mjs <command> [args...]");
  process.exit(2);
}

// `detached` gives the command and every descendant its own process group.
// The setup watchdog signals only this supervisor, which keeps shell process
// group differences from macOS and Linux out of setup-worktree.sh.
const child = NodeChildProcess.spawn(command, args, {
  detached: true,
  stdio: "inherit",
});

let escalation;
let spawnFailed = false;

child.once("error", (error) => {
  spawnFailed = true;
  console.error(`[setup-worktree] failed to start ${command}: ${error.message}`);
});

const signalChildGroup = (signal) => {
  if (child.pid === undefined) {
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
};

process.once("SIGTERM", () => {
  signalChildGroup("SIGTERM");
  escalation = setTimeout(() => {
    signalChildGroup("SIGKILL");
  }, 5_000);
});

child.once("close", (code, signal) => {
  if (escalation !== undefined) {
    clearTimeout(escalation);
  }

  if (spawnFailed) {
    process.exit(127);
  }
  if (code !== null) {
    process.exit(code);
  }
  process.exit(signal === "SIGKILL" ? 137 : 143);
});
