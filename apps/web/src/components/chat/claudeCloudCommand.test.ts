// @effect-diagnostics nodeBuiltinImport:off - verifies argument boundaries through a real shell.
import { describe, expect, it } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import { claudeCloudCommand, claudeCloudSessionId } from "./claudeCloudCommand";

describe("Claude cloud commands", () => {
  // quarantine: #30009 Windows has no POSIX shell; cloud launch currently supports macOS/Linux.
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "keeps task text literal through a POSIX shell",
    () => {
      const message = "Fix O'Brien's $(echo injected) `whoami` $HOME; <file>";
      const command = claudeCloudCommand({
        binaryPath: "printf",
        platform: "linux",
        message,
        session: "",
      });
      const result = NodeChildProcess.spawnSync(
        "/bin/sh",
        ["-c", command.replace("'--cloud'", "'%s'")],
        {
          encoding: "utf8",
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(message);
    },
  );
  it("normalizes cloud links and rejects other origins and terminal injection", () => {
    expect(claudeCloudSessionId("https://claude.ai/code/session_abc?from=cli")).toBe("session_abc");
    for (const session of [
      "https://evil.test/code/session_abc",
      "https://claude.ai@evil.test/code/session_abc",
      "session_abc\rwhoami",
      "local-id",
    ]) {
      expect(claudeCloudSessionId(session)).toBeNull();
    }
    for (const message of [
      "",
      "hello\rwhoami",
      "hello\nworld",
      "hello\x1b[31m",
      "--help",
      "session_abc",
      "é".repeat(2100),
    ]) {
      expect(() =>
        claudeCloudCommand({ binaryPath: "claude", platform: "linux", message, session: "" }),
      ).toThrow();
    }
  });
  it("sends follow-ups to the normalized cloud ID", () => {
    expect(
      claudeCloudCommand({
        binaryPath: "claude",
        platform: "darwin",
        message: "It's ready",
        session: "https://claude.ai/code/cse_abc?from=cli",
      }),
    ).toBe("'claude' '-p' 'It'\"'\"'s ready' '--cloud' 'cse_abc' '--output-format' 'json'");
    expect(() =>
      claudeCloudCommand({
        binaryPath: "claude",
        platform: "windows",
        message: "hello",
        session: "",
      }),
    ).toThrow();
  });
});
