import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import {
  assertSupportedCodexCliVersion,
  type CodexCliCommandRunner,
  runCodexCliCommand,
} from "./codexCliProbe";

class MockChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn();
}

describe("runCodexCliCommand", () => {
  it("rejects when the child process closes without an exit code", async () => {
    const child = new MockChildProcess();
    spawnMock.mockReturnValueOnce(child);

    const commandPromise = runCodexCliCommand({
      binaryPath: "codex",
      args: ["--version"],
      timeoutMs: 1_000,
    });

    child.emit("close", null, null);

    await expect(commandPromise).rejects.toThrow("Codex CLI process exited without an exit code.");
  });
});

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

  it("rejects when the version output cannot be parsed", async () => {
    const runCommand = vi.fn<CodexCliCommandRunner>().mockResolvedValue({
      stdout: "codex-cli version unknown\n",
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
    ).rejects.toThrow("Codex CLI version check failed. Could not parse Codex CLI version from output.");
  });
});
