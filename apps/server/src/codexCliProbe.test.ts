import { describe, expect, it, vi } from "vitest";

import {
  assertSupportedCodexCliVersion,
  type CodexCliCommandRunner,
} from "./codexCliProbe";

describe("assertSupportedCodexCliVersion", () => {
  it("retries a timed out version check once before succeeding", async () => {
    const runCommand = vi
      .fn<CodexCliCommandRunner>()
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        code: 124,
        timedOut: true,
      })
      .mockResolvedValueOnce({
        stdout: "codex-cli 0.112.0\n",
        stderr: "",
        code: 0,
      });

    await expect(
      assertSupportedCodexCliVersion(
        {
          binaryPath: "codex",
          cwd: "/tmp",
        },
        runCommand,
      ),
    ).resolves.toBeUndefined();

    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("surfaces a timeout after exhausting retries", async () => {
    const runCommand = vi.fn<CodexCliCommandRunner>().mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 124,
      timedOut: true,
    });

    await expect(
      assertSupportedCodexCliVersion(
        {
          binaryPath: "codex",
          cwd: "/tmp",
        },
        runCommand,
      ),
    ).rejects.toThrow("Failed to execute Codex CLI version check: Timed out while running command.");

    expect(runCommand).toHaveBeenCalledTimes(2);
  });
});
