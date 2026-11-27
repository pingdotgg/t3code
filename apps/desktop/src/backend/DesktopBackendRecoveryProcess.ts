// @effect-diagnostics globalTimers:off -- Worker deadlines run at child-process callback boundaries outside Effect fibers.
// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only helper owns a Node child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export type RecoveryWorkerMessage =
  | { readonly type: "recovering"; readonly pid: number }
  | { readonly type: "error"; readonly operation: string }
  | { readonly type: "tracked"; readonly record: string };

const trackDeadlineMs = 5_000;
// Covers the worker's SIGTERM and SIGKILL grace periods with room to start.
const recoverDeadlineMs = 10_000;

/** Runs recovery's native process inspection in a helper so a stall cannot block desktop main. */
export function make(input: {
  readonly appDataDirectory: string;
  readonly stateDir: string;
  readonly onRecovery: (pid: number) => void;
  readonly onError: (operation: string) => void;
}) {
  const run = (
    operation: "track" | "recover",
    deadlineMs: number,
    options: { readonly backendPid?: number; readonly signal?: AbortSignal } = {},
  ) =>
    new Promise<string | undefined>((resolve) => {
      let record: string | undefined;
      let worker: NodeChildProcess.ChildProcess;
      try {
        worker = NodeChildProcess.fork(
          // Main is bundled to dist-electron/main.cjs; the worker is a separate entry under it.
          NodePath.join(__dirname, "backend", "DesktopBackendRecoveryWorker.cjs"),
          [
            operation,
            input.appDataDirectory,
            input.stateDir,
            String(process.pid),
            ...(options.backendPid === undefined ? [] : [String(options.backendPid)]),
          ],
          {
            // The default macOS Helper executable would not match the backend's recorded executable.
            execPath: process.execPath,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
            execArgv: [],
            stdio: ["ignore", "ignore", "inherit", "ipc"],
          },
        );
      } catch {
        input.onError("start recovery worker");
        resolve(undefined);
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        options.signal?.removeEventListener("abort", stop);
        resolve(record);
      };
      const stop = () => {
        worker.kill("SIGKILL");
        finish();
      };
      const deadline = setTimeout(() => {
        input.onError(`${operation} deadline`);
        stop();
      }, deadlineMs);
      deadline.unref();
      if (options.signal?.aborted) stop();
      else options.signal?.addEventListener("abort", stop, { once: true });
      worker.on("message", (raw) => {
        const message = raw as RecoveryWorkerMessage;
        if (message.type === "recovering") input.onRecovery(message.pid);
        else if (message.type === "error") input.onError(message.operation);
        else record = message.record;
      });
      worker.once("error", () => {
        input.onError("recovery worker");
        stop();
      });
      worker.once("exit", finish);
    });

  return {
    track: async (backendPid: number) => {
      const record = await run("track", trackDeadlineMs, { backendPid });
      if (record === undefined) return undefined;
      return () =>
        NodeFSP.unlink(record).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") input.onError("forget backend");
        });
    },
    recover: (signal: AbortSignal) =>
      run("recover", recoverDeadlineMs, { signal }).then(() => undefined),
  };
}
