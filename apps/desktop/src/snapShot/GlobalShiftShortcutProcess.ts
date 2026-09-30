// @effect-diagnostics globalTimers:off -- The child-process shutdown watchdog runs at a worker callback boundary outside any Effect fiber.
// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only helper owns a Node child process for global shortcut capture.

import * as NodeChildProcess from "node:child_process";

import type { SnapShotModifier } from "@t3tools/contracts";

export function startGlobalShiftShortcutProcess(
  workerPath: string,
  modifier: SnapShotModifier,
  onTrigger: () => void,
  onFailure: (error: Error) => void,
): Promise<() => void> {
  const worker = NodeChildProcess.fork(workerPath, [modifier], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    execArgv: [],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      worker.kill();
      const forceKill = setTimeout(() => worker.kill("SIGKILL"), 1_000);
      forceKill.unref?.();
      worker.once("exit", () => clearTimeout(forceKill));
    };
    const fail = (error: Error) => {
      if (stopped) return;
      if (settled) {
        stop();
        onFailure(error);
        return;
      }
      settled = true;
      stop();
      reject(error);
    };

    worker.on("message", (message) => {
      if (message === "ready" && !settled) {
        settled = true;
        resolve(stop);
        return;
      }
      if (message !== "trigger" || !settled || stopped) return;
      try {
        onTrigger();
      } catch {}
    });
    worker.once("error", (error) => {
      fail(error);
    });
    worker.once("exit", (code) => {
      fail(new Error(`Snapshot shortcut helper exited with code ${code}`));
    });
  });
}
