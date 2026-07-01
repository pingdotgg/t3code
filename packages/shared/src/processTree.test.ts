import type { SpawnSyncReturns } from "node:child_process";

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

function makeTaskkillResult(status: number | null, error?: Error): SpawnSyncReturns<Buffer> {
  const result: SpawnSyncReturns<Buffer> = {
    pid: 1234,
    output: [],
    stdout: Buffer.from(""),
    stderr: Buffer.from(""),
    status,
    signal: null,
  };
  if (error) {
    result.error = error;
  }
  return result;
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

  it("does not fall back when taskkill succeeds", () => {
    const child = makeFakeChild(1234);
    killProcessTree(child, "SIGTERM", "win32", () => makeTaskkillResult(0));
    expect(child.killed).toEqual([]);
  });

  it("falls back to signal-based kill when taskkill returns a nonzero status", () => {
    const child = makeFakeChild(1234);
    killProcessTree(child, "SIGKILL", "win32", () => makeTaskkillResult(5));
    expect(child.killed).toEqual(["SIGKILL"]);
  });

  it("falls back to signal-based kill when taskkill cannot be launched", () => {
    const child = makeFakeChild(1234);
    killProcessTree(child, "SIGTERM", "win32", () =>
      makeTaskkillResult(null, new Error("spawn taskkill ENOENT")),
    );
    expect(child.killed).toEqual(["SIGTERM"]);
  });
});
