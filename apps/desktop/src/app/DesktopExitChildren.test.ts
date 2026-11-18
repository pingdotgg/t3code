// @effect-diagnostics nodeBuiltinImport:off - Spawns a real process tree for /proc.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import { assert, describe, it } from "@effect/vitest";

import { stopChildProcessesBeforeExit, stopZygotesBeforeExit } from "./DesktopExitChildren.ts";

const isRunning = (pid: number) => {
  try {
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
    return !"ZX".includes(stat.charAt(stat.lastIndexOf(")") + 2));
  } catch {
    return false;
  }
};

describe.runIf(NodeFS.existsSync("/proc/self/task"))("stopChildProcessesBeforeExit", () => {
  it("terminates every child of the given process before returning", async () => {
    const parent = NodeChildProcess.spawn(
      "sh",
      ["-c", "sleep 60 & echo $!; sleep 60 & echo $!; wait"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      const childPids = await new Promise<Array<number>>((resolve) => {
        let output = "";
        parent.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          const pids = output.split("\n").filter(Boolean).map(Number);
          if (pids.length === 2) resolve(pids);
        });
      });
      assert.isTrue(childPids.every(isRunning));

      assert.deepStrictEqual(stopChildProcessesBeforeExit(parent.pid!), []);

      assert.isFalse(childPids.some(isRunning));
    } finally {
      parent.kill("SIGKILL");
    }
  });

  it("kills zygote children before returning and leaves other helpers running", async () => {
    const spawnTitled = async (title: string) => {
      const child = NodeChildProcess.spawn("sleep", ["60"], { argv0: title, stdio: "ignore" });
      await new Promise((resolve) => child.once("spawn", resolve));
      return child;
    };
    // Chromium rewrites a zygote's argv into one space-separated title.
    const zygote = await spawnTitled("/opt/T3 Code/t3code --type=zygote --no-sandbox");
    const utility = await spawnTitled("/opt/T3 Code/t3code --type=utility");
    try {
      stopZygotesBeforeExit(process.pid);

      assert.isFalse(isRunning(zygote.pid!));
      assert.isTrue(isRunning(utility.pid!));
    } finally {
      zygote.kill("SIGKILL");
      utility.kill("SIGKILL");
    }
  });
});
