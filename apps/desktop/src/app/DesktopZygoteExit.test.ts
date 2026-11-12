// @effect-diagnostics nodeBuiltinImport:off - Spawns real child processes for /proc to report.
import * as NodeChildProcess from "node:child_process";

import { describe, expect, it } from "vite-plus/test";

import { stopZygotesBeforeExit } from "./DesktopZygoteExit.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- The helper reads Linux /proc.
const isLinux = process.platform === "linux";

const spawnTitled = async (title: string) => {
  const child = NodeChildProcess.spawn("sleep", ["30"], { argv0: title, stdio: "ignore" });
  const exited = new Promise<NodeJS.Signals | null>((resolve) =>
    child.on("exit", (_code, signal) => resolve(signal)),
  );
  await new Promise((resolve) => child.on("spawn", resolve));
  return { child, exited };
};

describe("stopZygotesBeforeExit", () => {
  it.skipIf(!isLinux)("kills zygote children and leaves other helpers running", async () => {
    // Chromium rewrites a zygote's argv into one space-separated title.
    const zygote = await spawnTitled("/opt/T3 Code/t3code --type=zygote --no-sandbox");
    const utility = await spawnTitled("/opt/T3 Code/t3code --type=utility");
    try {
      stopZygotesBeforeExit(process.pid);

      expect(await zygote.exited).toBe("SIGKILL");
      expect(utility.child.exitCode).toBeNull();
      expect(utility.child.signalCode).toBeNull();
    } finally {
      zygote.child.kill("SIGKILL");
      utility.child.kill("SIGKILL");
    }
  });
});
