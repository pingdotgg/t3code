import { describe, expect, it, vi } from "vitest";

import { runProbeProcess } from "./runProbeProcess";

describe("runProbeProcess", () => {
  it("forces truncated output mode while preserving other options", async () => {
    const runner = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
    });

    await runProbeProcess(
      "ps",
      ["-eo", "pid=,ppid="],
      {
        timeoutMs: 500,
        allowNonZeroExit: true,
        maxBufferBytes: 1024,
        cwd: "/tmp",
      },
      runner,
    );

    expect(runner).toHaveBeenCalledWith("ps", ["-eo", "pid=,ppid="], {
      timeoutMs: 500,
      allowNonZeroExit: true,
      maxBufferBytes: 1024,
      cwd: "/tmp",
      outputMode: "truncate",
    });
  });
});
