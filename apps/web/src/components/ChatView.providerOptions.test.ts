import { describe, expect, it } from "vitest";

import { getProviderOptionsForDispatch } from "./ChatView.providerOptions";

describe("getProviderOptionsForDispatch", () => {
  it("returns Claude Code overrides when configured", () => {
    expect(
      getProviderOptionsForDispatch(
        {
          claudeBinaryPath: "/usr/local/bin/claude",
          claudeHomePath: "/tmp/.claude",
          codexBinaryPath: "",
          codexHomePath: "",
        },
        "claudeCode",
      ),
    ).toEqual({
      claudeCode: {
        binaryPath: "/usr/local/bin/claude",
        homePath: "/tmp/.claude",
      },
    });
  });

  it("returns Codex overrides when configured", () => {
    expect(
      getProviderOptionsForDispatch(
        {
          claudeBinaryPath: "",
          claudeHomePath: "",
          codexBinaryPath: "/usr/local/bin/codex",
          codexHomePath: "/tmp/.codex",
        },
        "codex",
      ),
    ).toEqual({
      codex: {
        binaryPath: "/usr/local/bin/codex",
        homePath: "/tmp/.codex",
      },
    });
  });

  it("omits overrides when the selected provider has no configured values", () => {
    expect(
      getProviderOptionsForDispatch(
        {
          claudeBinaryPath: "/usr/local/bin/claude",
          claudeHomePath: "/tmp/.claude",
          codexBinaryPath: "",
          codexHomePath: "",
        },
        "codex",
      ),
    ).toBeUndefined();
  });
});
