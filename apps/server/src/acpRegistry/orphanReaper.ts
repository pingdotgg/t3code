// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

/**
 * Some ACP agents (notably Junie via its `.app` launcher) detach from the parent process
 * on macOS — when t3code exits, the launcher PID dies but the actual agent process orphans
 * and survives across server restarts, accumulating zombie JVMs that consume RAM and CPU.
 *
 * On boot, before spawning a new instance, scan `ps` for any process whose command line
 * starts with our managed binary path and kill it (SIGKILL). Safe because we only target
 * binaries under our own cache directory (`~/.t3/acp-agents/...`).
 */
export const reapOrphanProcesses = (binaryPath: string): Effect.Effect<number> =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    if (!binaryPath || platform === "win32") return 0;
    return yield* Effect.sync(() => {
      try {
        // ps -A -o pid=,command= → newline-separated "PID COMMAND" pairs
        const output = NodeChildProcess.execFileSync("/bin/ps", ["-A", "-o", "pid=,command="], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        const myPid = process.pid;
        const victims: number[] = [];
        for (const line of output.split("\n")) {
          const match = line.trim().match(/^(\d+)\s+(.*)$/);
          if (!match) continue;
          const pid = Number(match[1]);
          const cmd = match[2];
          if (pid === myPid) continue;
          if (!cmd || !cmd.startsWith(binaryPath)) continue;
          victims.push(pid);
        }
        if (victims.length === 0) return 0;
        for (const pid of victims) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Process already dead or permission denied — ignore.
          }
        }
        return victims.length;
      } catch {
        return 0;
      }
    });
  });
