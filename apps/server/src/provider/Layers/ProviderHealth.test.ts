import { describe, expect, it } from "vitest";

import type { ProcessRunResult } from "../../processRunner";
import { checkProviderStatusesOnStartup } from "./ProviderHealth";

function result(input: Partial<ProcessRunResult>): ProcessRunResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...input,
  };
}

describe("checkProviderStatusesOnStartup", () => {
  it("returns ready when codex is installed and authenticated", async () => {
    const status = await checkProviderStatusesOnStartup(async (_command, args) => {
      if (args.join(" ") === "--version") {
        return result({ stdout: "codex 1.0.0\n" });
      }
      if (args.join(" ") === "auth status --json") {
        return result({ stdout: '{"authenticated":true}\n' });
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    expect(status).toEqual([
      expect.objectContaining({
        provider: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
      }),
    ]);
  });

  it("returns unavailable when codex is missing", async () => {
    const status = await checkProviderStatusesOnStartup(async () => {
      throw new Error("Command not found: codex");
    });

    expect(status).toEqual([
      expect.objectContaining({
        provider: "codex",
        status: "error",
        available: false,
        authStatus: "unknown",
        message: "Codex CLI (`codex`) is not installed or not on PATH.",
      }),
    ]);
  });

  it("returns unauthenticated when auth probe reports login required", async () => {
    const status = await checkProviderStatusesOnStartup(async (_command, args) => {
      if (args.join(" ") === "--version") {
        return result({ stdout: "codex 1.0.0\n" });
      }
      if (args.join(" ") === "auth status --json") {
        return result({
          code: 1,
          stderr: "Not logged in. Run codex login.",
        });
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    expect(status).toEqual([
      expect.objectContaining({
        provider: "codex",
        status: "error",
        available: true,
        authStatus: "unauthenticated",
        message: "Codex CLI is not authenticated. Run `codex login` and try again.",
      }),
    ]);
  });

  it("returns warning when auth status command is unsupported", async () => {
    const status = await checkProviderStatusesOnStartup(async (_command, args) => {
      if (args.join(" ") === "--version") {
        return result({ stdout: "codex 1.0.0\n" });
      }
      if (args.join(" ") === "auth status --json") {
        return result({
          code: 2,
          stderr: "error: unknown command 'auth'",
        });
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    expect(status).toEqual([
      expect.objectContaining({
        provider: "codex",
        status: "warning",
        available: true,
        authStatus: "unknown",
        message:
          "Codex CLI authentication status command is unavailable in this Codex version.",
      }),
    ]);
  });
});
