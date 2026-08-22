import { describe, expect, it } from "vite-plus/test";

import { detectCopilotAuthFromEnvironment, parseCopilotVersionOutput } from "./CopilotProvider.ts";

describe("parseCopilotVersionOutput", () => {
  it("parses the version from `copilot version` output", () => {
    const parsed = parseCopilotVersionOutput({
      stdout: "GitHub Copilot CLI 1.0.80\n",
      stderr: "",
      code: 0,
    });
    expect(parsed.version).toBe("1.0.80");
    expect(parsed.status).toBe("ready");
  });

  it("reports a non-zero exit as an error", () => {
    const parsed = parseCopilotVersionOutput({
      stdout: "",
      stderr: "boom",
      code: 127,
    });
    expect(parsed.version).toBeNull();
    expect(parsed.status).toBe("error");
    expect(parsed.message).toBeDefined();
  });

  it("warns when a zero-exit command produces unrecognized output", () => {
    const parsed = parseCopilotVersionOutput({
      stdout: "some other tool v9\n",
      stderr: "",
      code: 0,
    });
    expect(parsed.version).toBeNull();
    expect(parsed.status).toBe("warning");
    expect(parsed.message).toBeDefined();
  });

  it("treats a non-zero exit whose output says 'not found' as a missing binary", () => {
    const parsed = parseCopilotVersionOutput({
      stdout: "",
      stderr: "zsh: command not found: copilot",
      code: 127,
    });
    expect(parsed.status).toBe("error");
    expect(parsed.message).toContain("not installed");
  });
});

describe("detectCopilotAuthFromEnvironment", () => {
  it("treats a Copilot/GH token as authenticated", () => {
    expect(detectCopilotAuthFromEnvironment({ COPILOT_GITHUB_TOKEN: "x" }).status).toBe(
      "authenticated",
    );
    expect(detectCopilotAuthFromEnvironment({ GH_TOKEN: "x" }).status).toBe("authenticated");
    expect(detectCopilotAuthFromEnvironment({ GITHUB_TOKEN: "x" }).status).toBe("authenticated");
  });

  it("is unknown when no token is present", () => {
    expect(detectCopilotAuthFromEnvironment({}).status).toBe("unknown");
    expect(detectCopilotAuthFromEnvironment({ COPILOT_GITHUB_TOKEN: "  " }).status).toBe("unknown");
  });

  it("does not let a blank higher-precedence token mask a real one", () => {
    expect(
      detectCopilotAuthFromEnvironment({ COPILOT_GITHUB_TOKEN: "", GH_TOKEN: "real" }).status,
    ).toBe("authenticated");
  });
});
