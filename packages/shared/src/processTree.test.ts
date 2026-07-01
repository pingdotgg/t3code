import { describe, expect, it } from "vitest";

import { killProcessTree, type KillableProcess } from "./processTree.ts";

function makeFakeChild(pid: number | undefined): KillableProcess & { killed: NodeJS.Signals[] } {
  const killed: NodeJS.Signals[] = [];
  return {
    pid,
    killed,
    kill(signal: NodeJS.Signals = "SIGTERM") {
      killed.push(signal);
      return true;
    },
  };
}

describe("killProcessTree", () => {
  it("uses signal-based kill on POSIX", () => {
    const child = makeFakeChild(1234);
    killProcessTree(child, "SIGTERM", "linux");
    expect(child.killed).toEqual(["SIGTERM"]);
  });

  it("falls back to signal-based kill when the Windows PID is unknown", () => {
    const child = makeFakeChild(undefined);
    killProcessTree(child, "SIGKILL", "win32");
    expect(child.killed).toEqual(["SIGKILL"]);
  });
});
