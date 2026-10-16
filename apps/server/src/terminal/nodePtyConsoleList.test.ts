import * as NodeEvents from "node:events";
import * as NodeModule from "node:module";

import { afterEach, describe, expect, it } from "vite-plus/test";

// Exercises the patched console-list helper in patches/node-pty@1.2.0-beta.15.patch.
// The agent calls `require("child_process").fork` at call time, so replacing it on
// the shared CJS module stands in for the forked helper on every platform.
const requireCjs = NodeModule.createRequire(import.meta.url);
const childProcess: typeof import("node:child_process") = requireCjs("child_process");
const {
  WindowsPtyAgent,
}: {
  WindowsPtyAgent: {
    prototype: { _getConsoleProcessList(this: { _innerPid: number }): Promise<number[]> };
  };
} = requireCjs("node-pty/lib/windowsPtyAgent.js");
const originalFork = childProcess.fork;

const SHELL_PID = 4242;

function getConsoleProcessList(
  driveHelper: (helper: NodeEvents.EventEmitter) => void,
): Promise<number[]> {
  const helper = Object.assign(new NodeEvents.EventEmitter(), { kill: () => true });
  childProcess.fork = (() => {
    queueMicrotask(() => driveHelper(helper));
    return helper;
  }) as unknown as typeof childProcess.fork;
  return WindowsPtyAgent.prototype._getConsoleProcessList.call({ _innerPid: SHELL_PID });
}

describe("node-pty console process list helper", () => {
  afterEach(() => {
    childProcess.fork = originalFork;
  });

  it("returns the helper's list when it replies and then closes", async () => {
    const list = await getConsoleProcessList((helper) => {
      helper.emit("message", { consoleProcessList: [SHELL_PID, 5001, 5002] });
      helper.emit("exit", 0, null);
      helper.emit("close", 0, null);
    });
    expect(list).toEqual([SHELL_PID, 5001, 5002]);
  });

  it("keeps waiting for the reply when exit arrives before the IPC message", async () => {
    const list = await getConsoleProcessList((helper) => {
      helper.emit("exit", 0, null);
      helper.emit("message", { consoleProcessList: [SHELL_PID, 5001] });
      helper.emit("close", 0, null);
    });
    expect(list).toEqual([SHELL_PID, 5001]);
  });

  it("falls back to the shell PID when the helper closes without replying", async () => {
    const list = await getConsoleProcessList((helper) => {
      helper.emit("exit", 1, null);
      helper.emit("close", 1, null);
    });
    expect(list).toEqual([SHELL_PID]);
  });

  it("falls back to the shell PID when the helper fails to spawn", async () => {
    const list = await getConsoleProcessList((helper) => {
      helper.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    });
    expect(list).toEqual([SHELL_PID]);
  });
});
