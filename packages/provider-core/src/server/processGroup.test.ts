// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { signalProcessGroup } from "./processGroup.ts";

const errorCode = (run: () => void) => {
  try {
    run();
    return undefined;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code;
  }
};

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("signalProcessGroup", () => {
  // Signal 0 probes without killing.
  it("never reaches this server's group or every process the user owns", () => {
    for (const pid of [1, 0, -1, Number.NaN, 1.5]) {
      expect(
        errorCode(() => signalProcessGroup(pid, 0)),
        `pid ${pid}`,
      ).toBe("ESRCH");
    }
  });

  it("signals a spawned process group", async () => {
    const child = NodeChildProcess.spawn("/bin/sh", ["-c", "sleep 600 & wait"], {
      detached: true,
      stdio: "ignore",
    });
    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once("exit", (_code, signal) => resolve(signal)),
    );
    const pid = child.pid!;

    expect(errorCode(() => signalProcessGroup(pid, 0))).toBeUndefined();
    signalProcessGroup(pid, "SIGKILL");
    expect(await exited).toBe("SIGKILL");
  });
});
