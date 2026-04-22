import { spawn, spawnSync } from "node:child_process";

const forceShutdownTimeoutMs = 1_500;

let shuttingDown = false;
let shutdownPromise = null;
let exitCode = 0;

const children = new Map();

function isWindows() {
  return process.platform === "win32";
}

function resolveBunCommand() {
  return isWindows() ? "bun.cmd" : "bun";
}

function resolveSignalExitCode(signal) {
  if (signal === "SIGINT") {
    return 130;
  }
  if (signal === "SIGTERM") {
    return 143;
  }
  if (signal === "SIGHUP") {
    return 129;
  }
  return 1;
}

function childFailureExitCode(code, signal) {
  if (typeof code === "number") {
    return code === 0 ? 1 : code;
  }

  if (typeof signal === "string") {
    return resolveSignalExitCode(signal);
  }

  return 1;
}

function killChildTreeByPid(pid, signal) {
  if (typeof pid !== "number") {
    return;
  }

  if (isWindows()) {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }

  spawnSync("pkill", [`-${signal}`, "-P", String(pid)], { stdio: "ignore" });
}

function spawnChild(name, command, args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    shell: isWindows(),
  });

  children.set(name, child);

  child.once("exit", (code, signal) => {
    children.delete(name);

    if (shuttingDown) {
      return;
    }

    exitCode = childFailureExitCode(code, signal);
    console.error(`[desktop-dev] ${name} exited unexpectedly (code=${code}, signal=${signal})`);
    void shutdown(exitCode);
  });

  child.once("error", (error) => {
    if (shuttingDown) {
      return;
    }

    exitCode = 1;
    console.error(`[desktop-dev] failed to start ${name}`, error);
    void shutdown(exitCode);
  });

  return child;
}

async function stopChild(child, signal) {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }

  await new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    child.once("exit", finish);

    child.kill(signal);
    killChildTreeByPid(child.pid, signal.replace("SIG", ""));

    setTimeout(() => {
      if (settled) {
        return;
      }

      child.kill("SIGKILL");
      killChildTreeByPid(child.pid, "KILL");
      finish();
    }, forceShutdownTimeoutMs).unref();
  });
}

async function shutdown(nextExitCode) {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shuttingDown = true;
  exitCode = nextExitCode;

  const activeChildren = [...children.values()];

  shutdownPromise = Promise.all(
    activeChildren.map((child) => stopChild(child, "SIGTERM").catch(() => undefined)),
  ).then(() => {
    process.exit(exitCode);
  });

  return shutdownPromise;
}

spawnChild("dev:bundle", resolveBunCommand(), ["run", "dev:bundle"]);
spawnChild("dev:electron", process.execPath, ["scripts/dev-electron.mjs"]);

process.once("SIGINT", () => {
  void shutdown(130);
});
process.once("SIGTERM", () => {
  void shutdown(143);
});
process.once("SIGHUP", () => {
  void shutdown(129);
});
